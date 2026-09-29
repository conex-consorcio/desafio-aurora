import { Inject, Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { ErroDoParceiro } from "@shared/http/erro-do-parceiro.error";
import { PrismaService } from "@shared/prisma/prisma.service";
import { REDIS_CLIENT } from "@shared/redis/redis.module";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { LancesService, type RegistrarLanceInput } from "./lances.service";

/**
 * Fila de trabalho do lance mensual.
 *
 * Em vez de que todas as instancias leam e registrem as mesmas cotas, cada
 * cota se enfileira uma vez e a reclama um unico worker:
 *   - enfileirar: so o vencedor do job lock le o banco e faz ZADD;
 *   - claim: Lua atomico (ZPOPMIN + ZADD a processando com lease);
 *   - reaper: devolve os itens a fila quando o lease expira;
 *   - reintento: uma cota que falha volta com score = tentativa (backoff);
 *     ao esgotar MAX_TENTATIVAS passa a `lances:falhadas:<mes>`.
 */
const JOB_TTL_MS = 30_000;
const FEITO_TTL_S = 3_600;
const ESPERA_FEITO_MS = 10_000;
const LEASE_WORKER_MS = 15_000;
const DURACAO_MAX_MS = 10 * 60_000;
const POLL_MS = 200;
const MAX_TENTATIVAS = 3;
const CHUNK_ZADD = 500;
const GRACE_DRAIN_MS = 20_000;

/** Claim atomico: tira da fila e marca como processando com lease. */
const RECLAMAR = `
local membro = redis.call("zpopmin", KEYS[1])
if not membro or #membro == 0 then
  return nil
end
local chave = membro[1]
local score = membro[2]
redis.call("zadd", KEYS[2], ARGV[1], chave)
return {chave, score}
`;

/** Reaper: itens de processando com lease vencido voltam a fila. */
const RETOMAR_ORFANOS = `
local orfanos = redis.call("zrangebyscore", KEYS[2], "-inf", ARGV[1])
local movidos = 0
for _, chave in ipairs(orfanos) do
  redis.call("zrem", KEYS[2], chave)
  redis.call("zadd", KEYS[1], 0, chave)
  movidos = movidos + 1
end
return movidos
`;

const SOLTAR_JOB = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function chaveJob(mes: string): string {
  return `lances:job:${mes}`;
}

function chaveFeito(mes: string): string {
  return `lances:job:${mes}:feito`;
}

function chaveFila(mes: string): string {
  return `lances:fila:${mes}`;
}

function chaveProcessando(mes: string): string {
  return `lances:processando:${mes}`;
}

function chaveFalhadas(mes: string): string {
  return `lances:falhadas:${mes}`;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class LancesWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(LancesWorker.name);
  private readonly emVoo = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly lances: LancesService,
  ) {}

  /**
   * SIGTERM: espera (com tope) que o registro em voo termine, para nao
   * matar uma chamada a Aurora a meias. Se o lease expira, o item
   * fica em `processando` e o reaper o recupera.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.emVoo.size === 0) return;

    const pendentes = Promise.allSettled([...this.emVoo]);
    const tope = dormir(GRACE_DRAIN_MS);
    await Promise.race([pendentes, tope]);
  }

  async rodar(mes: string): Promise<void> {
    const instancia = randomUUID();
    const ganhou = await this.redis.set(
      chaveJob(mes),
      instancia,
      "PX",
      JOB_TTL_MS,
      "NX",
    );

    if (ganhou) {
      try {
        await this.enfileirar(mes);
        await this.redis.set(chaveFeito(mes), "1", "EX", FEITO_TTL_S);
      } finally {
        await this.redis.eval(SOLTAR_JOB, 1, chaveJob(mes), instancia);
      }
    } else {
      await this.esperarFeito(mes);
    }

    await this.processar(mes);
  }

  /** So o vencedor do job lock le o banco e enfileira cada cota elegible. */
  private async enfileirar(mes: string): Promise<void> {
    const cotas = await this.prisma.cota.findMany({
      where: { situacao: "DISPONIVEL" },
    });

    if (cotas.length === 0) return;

    const membros = cotas.flatMap((cota) => [
      0,
      `${cota.grupo}:${cota.numero}`,
    ]);

    for (let i = 0; i < membros.length; i += CHUNK_ZADD) {
      await this.redis.zadd(chaveFila(mes), ...membros.slice(i, i + CHUNK_ZADD));
    }

    this.logger.log(`enfileiradas ${cotas.length} cotas do mes ${mes}`);
  }

  private async esperarFeito(mes: string): Promise<void> {
    const limite = Date.now() + ESPERA_FEITO_MS;

    while (Date.now() < limite) {
      if ((await this.redis.exists(chaveFeito(mes))) === 1) return;
      await dormir(POLL_MS);
    }
  }

  private async processar(mes: string): Promise<void> {
    const inicio = Date.now();

    while (Date.now() - inicio < DURACAO_MAX_MS) {
      const reclamada = await this.reclamar(mes);
      if (reclamada) {
        await this.registrarReclamada(mes, reclamada.chave, reclamada.score);
        continue;
      }

      await this.retomarOrfanos(mes);

      const drenado =
        (await this.redis.zcard(chaveFila(mes))) === 0 &&
        (await this.redis.zcard(chaveProcessando(mes))) === 0 &&
        ((await this.redis.exists(chaveFeito(mes))) === 1 ||
          (await this.redis.exists(chaveJob(mes))) === 0);

      if (drenado) return;
      await dormir(POLL_MS);
    }

    this.logger.warn(
      `fila do mes ${mes} nao drenou dentro da guarda; sera retomada em outra rodada`,
    );
  }

  private async reclamar(
    mes: string,
  ): Promise<{ chave: string; score: number } | undefined> {
    const resultado = await this.redis.eval(
      RECLAMAR,
      2,
      chaveFila(mes),
      chaveProcessando(mes),
      Date.now() + LEASE_WORKER_MS,
    );

    if (!Array.isArray(resultado) || typeof resultado[0] !== "string") {
      return undefined;
    }

    return { chave: resultado[0], score: Number(resultado[1]) };
  }

  /** Registra a cota reclamada e deixa o item no estado correto. */
  private registrarReclamada(mes: string, chave: string, score: number): Promise<void> {
    const trabalho = this.executarReclamada(mes, chave, score);
    this.emVoo.add(trabalho);
    void trabalho
      .finally(() => {
        this.emVoo.delete(trabalho);
      })
      .catch(() => {});
    return trabalho;
  }

  private async executarReclamada(
    mes: string,
    chave: string,
    score: number,
  ): Promise<void> {
    const [grupo, cota] = chave.split(":");

    if (!grupo || !cota) {
      this.logger.warn(`chave de fila malformada: ${chave}`);
      await this.redis.zrem(chaveProcessando(mes), chave);
      return;
    }

    const input: RegistrarLanceInput = { grupo, cota, assembleia: mes };

    try {
      await this.lances.registrar(input);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);

      if (this.eTransitorio(erro) && score + 1 < MAX_TENTATIVAS) {
        await this.redis.zadd(chaveFila(mes), score + 1, chave);
        this.logger.warn(`cota ${chave} falhou e se reenfileira (tentativa ${score + 1}): ${mensagem}`);
        return;
      }

      await this.redis.sadd(chaveFalhadas(mes), chave);
      this.logger.error(
        `cota ${chave} esgotou as tentativas ou falhou de forma permanente; fica fora do mes: ${mensagem}`,
      );
    } finally {
      await this.redis.zrem(chaveProcessando(mes), chave);
    }
  }

  /**
   * Transitorio: se reintenta. Permanente (4xx do parceiro): nao tem
   * sentido repetir; fica em `falhadas` para reconciliacao manual.
   *
   * 401 e transitorio, nao permanente: a Aurora mantem UM token valido por
   * vez e a renovacion de outra instancia invalida o nosso. O cliente ja
   * reintenta uma vez; se o thrash vence tambem ali, este reintento absorbe.
   * Os demais 4xx (400, 422...) seguem permanentes.
   */
  private eTransitorio(erro: unknown): boolean {
    if (!(erro instanceof ErroDoParceiro)) return true;

    const status = erro.status;
    if (status === undefined) return true;
    return status >= 500 || status === 429 || status === 401;
  }

  private async retomarOrfanos(mes: string): Promise<void> {
    await this.redis.eval(
      RETOMAR_ORFANOS,
      2,
      chaveFila(mes),
      chaveProcessando(mes),
      Date.now(),
    );
  }
}