import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RedisService } from "@shared/redis/redis.service";
import { ConcurrencyInterruptedError } from "./map-with-concurrency";

const POLL_MS = 25;

/**
 * Uma espera legítima dura como máximo `esperaMaxMs` (10s); passado esse
 * tempo o worker lança "saturado" e deixa a entrada na cola. Uma entrada com
 * mais de `COLA_TTL_MS` de vida é uma espera morta (crash/timeout) e se
 * limpa sozinha — senão, depois de um run catastrófico, a cola acumularía
 * lixo que retrasa a próxima sincronização.
 */
const COLA_TTL_MS = 15_000;

/**
 * Semáforo distribuido JUSTO entre instancias.
 *
 * `leases` são os slots ativos (ZSET: id -> expiração). `cola` é uma FIFO de
 * espera (ZSET ordenado por sequência). `cola:tempo` guarda quando cada um
 * entrou na fila, para limpar os mortos. Quando alguém libera, se promove ao
 * primeiro da cola. Assim ninguén fura a fila: uma instancia que re-adquire de
 * imediato fica atrás das que já esperavam. Sem isto, o greedy deixa morrer
 * de fome à outra instancia (100ms de poll perde contra o re-acquire
 * instantáneo).
 */
const ADQUIRIR_SCRIPT = `
-- limpa esperas mortas (na cola há mais de COLA_TTL_MS)
local mortos = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', ARGV[2] - ARGV[5])
for _, m in ipairs(mortos) do
  redis.call('ZREM', KEYS[2], m)
  redis.call('ZREM', KEYS[4], m)
end
-- limpa leases vencidos
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
-- já o tenho (fui promovido) ou sigo esperando
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
-- ninguén espera e há slot livre: adquire direto
local ativos = redis.call('ZCARD', KEYS[1])
if ativos < tonumber(ARGV[4]) and redis.call('ZCARD', KEYS[2]) == 0 then
  redis.call('ZADD', KEYS[1], ARGV[2] + ARGV[3], ARGV[1])
  return 1
end
-- fila: entro ao final
local seq = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[2], seq, ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
return 0
`;

const LIBERAR_SCRIPT = `
-- limpa esperas mortas
local mortos = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[2] - ARGV[5])
for _, m in ipairs(mortos) do
  redis.call('ZREM', KEYS[2], m)
  redis.call('ZREM', KEYS[3], m)
end
-- solto o meu slot
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
-- promovo aos que esperan, na ordem, enquanto há slots livres
local ativos = redis.call('ZCARD', KEYS[1])
while ativos < tonumber(ARGV[4]) do
  local front = redis.call('ZRANGE', KEYS[2], 0, 0)
  if front[1] then
    redis.call('ZREM', KEYS[2], front[1])
    redis.call('ZREM', KEYS[3], front[1])
    redis.call('ZADD', KEYS[1], ARGV[2] + ARGV[3], front[1])
    ativos = ativos + 1
  else
    break
  end
end
return 1
`;

/**
 * Semáforo distribuido entre instancias.
 *
 * O semáforo local limita uma instância; isto limita o AGREGADO. Sem elo,
 * oito pods com 16 workers cada superaríam o limite do parceiro (20) e cairíam
 * 429. Os slots são leases com TTL: se o pod morre a meio, o slot se libera
 * sozinho quando o lease expira.
 *
 * As chaves levam `REDIS_PREFIX` (default "aurora") para que ambientes que
 * compartam o mesmo Redis não se contaminen.
 */
@Injectable()
export class LimiteGlobal {
  private readonly logger = new Logger(LimiteGlobal.name);
  private readonly limite: number;
  private readonly leaseMs: number;
  private readonly esperaMaxMs: number;
  private readonly chaveLeases: string;
  private readonly chaveCola: string;
  private readonly chaveSeq: string;
  private readonly chaveColaTempo: string;

  constructor(private readonly redis: RedisService) {
    this.limite = Number(process.env.AURORA_LIMITE_GLOBAL ?? 16);
    this.leaseMs = Number(process.env.AURORA_LEASE_MS ?? LimiteGlobal.leasePorDefault());
    this.esperaMaxMs = Number(process.env.AURORA_TIMEOUT_MS ?? 10_000);

    const prefijo = process.env.REDIS_PREFIX ?? "aurora";
    this.chaveLeases = `${prefijo}:limite:leases`;
    this.chaveCola = `${prefijo}:limite:cola`;
    this.chaveSeq = `${prefijo}:limite:seq`;
    this.chaveColaTempo = `${prefijo}:limite:cola:tempo`;

    if (this.limite < 1) {
      throw new Error(`AURORA_LIMITE_GLOBAL invalida: ${this.limite}`);
    }
    if (this.leaseMs < 1) {
      throw new Error(`AURORA_LEASE_MS invalida: ${this.leaseMs}`);
    }
  }

  /**
   * Reserva um slot global, esperando na fila FIFO até conseguir-lo ou que se
   * esgote `esperaMaxMs`. Se `abortar` devolve true, lança interrupção —
   * usado na drenagem por SIGTERM.
   */
  async adquirir(abortar?: () => boolean): Promise<string> {
    const myId = randomUUID();
    const inicio = Date.now();

    for (;;) {
      if (abortar?.()) {
        throw new ConcurrencyInterruptedError(0, 1);
      }

      if (await this.tentar(myId)) {
        return myId;
      }

      if (Date.now() - inicio >= this.esperaMaxMs) {
        throw new Error("limite de concorrencia global saturado");
      }
      await sleep(POLL_MS);
    }
  }

  async liberar(token: string): Promise<void> {
    const agora = Date.now();
    await this.redis.get().eval(
      LIBERAR_SCRIPT,
      3,
      this.chaveLeases,
      this.chaveCola,
      this.chaveColaTempo,
      token,
      agora,
      this.leaseMs,
      this.limite,
      COLA_TTL_MS,
    );
  }

  private async tentar(myId: string): Promise<boolean> {
    const redis = this.redis.get();

    // Ainda conectando (race de arranque): reintenta no poll em vez de
    // estourar. "close"/"end" é redis realmente caído: erro ruidoso.
    const status = redis.status;
    if (status === "ready") {
      const agora = Date.now();
      const resultado = await redis.eval(
        ADQUIRIR_SCRIPT,
        4,
        this.chaveLeases,
        this.chaveCola,
        this.chaveSeq,
        this.chaveColaTempo,
        myId,
        agora,
        this.leaseMs,
        this.limite,
        COLA_TTL_MS,
      );

      return resultado === 1;
    }
    if (status === "connect" || status === "wait" || status === "reconnecting") {
      return false;
    }
    throw new Error(
      "redis não disponível; não consigo reservar concorrencia global",
    );
  }

  private static leasePorDefault(): number {
    return Number(process.env.AURORA_TIMEOUT_MS ?? 10_000) + 1_000;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}