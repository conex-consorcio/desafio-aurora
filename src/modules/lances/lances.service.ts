import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { PrismaService } from "@shared/prisma/prisma.service";
import { REDIS_CLIENT } from "@shared/redis/redis.module";

export interface RegistrarLanceInput {
  grupo: string;
  cota: string;
  assembleia: string;
}

export interface RegistrarLanceResultado {
  protocolo: string;
  jaRegistrado: boolean;
}

export interface ResultadoLanceExterno {
  protocolo: string;
}

/** Porta. O service depende disto, nao de um cliente HTTP concreto. */
export interface FonteDeLances {
  registrar(input: RegistrarLanceInput): Promise<ResultadoLanceExterno>;
}

export const FONTE_LANCES = "FONTE_LANCES";

const LEASE_MS = 15_000;
/** TTL do flag "finishing": maior que o timeout da chamada a Aurora. */
const FINISHING_TTL_MS = 40_000;
const RESULTADO_TTL_S = 300;
const ESPERA_MS = FINISHING_TTL_MS + LEASE_MS + 5_000;
const POLL_MS = 100;
const INSERT_RETRIES = 3;

/** Libera o lock so se ainda for do mesmo dono (Lua atomica, 1 round-trip). */
const SOLTAR_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function chaveLock(input: RegistrarLanceInput): string {
  return `lance:lock:${input.grupo}:${input.cota}:${input.assembleia}`;
}

function chaveResultado(input: RegistrarLanceInput): string {
  return `lance:resultado:${input.grupo}:${input.cota}:${input.assembleia}`;
}

function chaveFinishing(input: RegistrarLanceInput): string {
  return `lance:finishing:${input.grupo}:${input.cota}:${input.assembleia}`;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Registra o lance da cota na assembleia do mes, no maximo UMA vez.
 *
 * A Aurora cobra por lance e nao faz idempotencia: duas chamadas sao duas
 * cobrancas. A arbitragem acontece ANTES do efeito externo, toda no Redis:
 *   - single-flight em processo (mesma instancia coalesce numa promise);
 *   - lock distribuido SET NX PX entre instancias;
 *   - flag "finishing": um vencedor lento mas vivo nao perde a posse;
 *   - chave de resultado: perdedores esperam la, nao tocan o banco.
 * O banco e apenas um registro duravel (append-only, sem restricaoes).
 */
@Injectable()
export class LancesService {
  private readonly logger = new Logger(LancesService.name);
  private readonly emVoo = new Map<string, Promise<RegistrarLanceResultado>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(FONTE_LANCES) private readonly fonte: FonteDeLances,
  ) {}

  async registrar(input: RegistrarLanceInput): Promise<RegistrarLanceResultado> {
    const chave = chaveResultado(input);
    const promessa = this.emVoo.get(chave);
    if (promessa) return promessa;

    const nova = this.executar(input);
    this.emVoo.set(chave, nova);
    try {
      return await nova;
    } finally {
      if (this.emVoo.get(chave) === nova) this.emVoo.delete(chave);
    }
  }

  private async executar(input: RegistrarLanceInput): Promise<RegistrarLanceResultado> {
    const jaRegistrado = await this.redis.get(chaveResultado(input));
    if (jaRegistrado) return { protocolo: jaRegistrado, jaRegistrado: true };

    const dono = randomUUID();
    const adquiriu = await this.redis.set(
      chaveLock(input),
      dono,
      "PX",
      LEASE_MS,
      "NX",
    );
    if (!adquiriu) return this.esperarResultado(input);

    return this.registrarComLock(input, dono);
  }

  /**
   * Dono do lock. Se um vencedor anterior ainda esta trabalhando (flag
   * "finishing"), libera o lock e espera: quem esta vivo, mesmo lento, nao e morto.
   */
  private async registrarComLock(
    input: RegistrarLanceInput,
    dono: string,
  ): Promise<RegistrarLanceResultado> {
    try {
      const terminando = await this.redis.get(chaveFinishing(input));
      if (terminando) {
        await this.redis.eval(SOLTAR_LOCK, 1, chaveLock(input), dono);
        return this.esperarResultado(input);
      }

      const protocolo = await this.protocoloRegistrado(input);
      if (protocolo) return { protocolo, jaRegistrado: true };

      await this.redis.set(chaveFinishing(input), dono, "PX", FINISHING_TTL_MS);

      const resposta = await this.fonte.registrar(input);

      await this.registrarNoBanco(input, resposta.protocolo);
      await this.redis.set(
        chaveResultado(input),
        resposta.protocolo,
        "EX",
        RESULTADO_TTL_S,
      );

      this.logger.log(
        `lance registrado grupo=${input.grupo} cota=${input.cota} assembleia=${input.assembleia}`,
      );

      return { protocolo: resposta.protocolo, jaRegistrado: false };
    } finally {
      await this.redis.eval(SOLTAR_LOCK, 1, chaveLock(input), dono);
      await this.redis.eval(SOLTAR_LOCK, 1, chaveFinishing(input), dono);
    }
  }

  /**
   * Recandidato que acaba de ganhar o lock: procura um protocolo ja gravado.
   * So aqui se toca o banco, e so se o Redis nao tem o resultado.
   */
  private async protocoloRegistrado(
    input: RegistrarLanceInput,
  ): Promise<string | undefined> {
    const noRedis = await this.redis.get(chaveResultado(input));
    if (noRedis) return noRedis;

    const noBanco = await this.prisma.lance.findFirst({
      where: {
        grupo: input.grupo,
        cota: input.cota,
        assembleia: input.assembleia,
      },
      select: { protocolo: true },
    });

    if (noBanco?.protocolo) {
      await this.redis.set(
        chaveResultado(input),
        noBanco.protocolo,
        "EX",
        RESULTADO_TTL_S,
      );
    }

    return noBanco?.protocolo ?? undefined;
  }

  /**
   * Perdeu o lock: espera o resultado no Redis. Se o "finishing" desaparece
   * (vencedor morto) e o lock esta livre, toma posse e registra.
   */
  private async esperarResultado(
    input: RegistrarLanceInput,
  ): Promise<RegistrarLanceResultado> {
    const limite = Date.now() + ESPERA_MS;

    while (Date.now() < limite) {
      const protocolo = await this.redis.get(chaveResultado(input));
      if (protocolo) return { protocolo, jaRegistrado: true };

      const terminando = await this.redis.get(chaveFinishing(input));
      if (!terminando) {
        const dono = randomUUID();
        const adquiriu = await this.redis.set(
          chaveLock(input),
          dono,
          "PX",
          LEASE_MS,
          "NX",
        );
        if (adquiriu) return this.registrarComLock(input, dono);
      }

      await dormir(POLL_MS);
    }

    throw new Error(
      `lance: registro nao concluiu em tempo grupo=${input.grupo} cota=${input.cota}`,
    );
  }

  /**
   * INSERT append-only com reintento ante erro transitorio do banco. O
   * protocolo serve de chave de idempotencia: se a tentativa anterior chegou
   * a gravar, se detecta e nao se duplica a fila.
   */
  private async registrarNoBanco(
    input: RegistrarLanceInput,
    protocolo: string,
  ): Promise<void> {
    for (let tentativa = 1; tentativa <= INSERT_RETRIES; tentativa += 1) {
      try {
        await this.prisma.lance.create({
          data: {
            grupo: input.grupo,
            cota: input.cota,
            assembleia: input.assembleia,
            protocolo,
          },
        });
        return;
      } catch (erro) {
        const jaGravado = await this.prisma.lance.findFirst({
          where: { protocolo },
          select: { id: true },
        });
        if (jaGravado) return;

        if (tentativa === INSERT_RETRIES) throw erro;
        await dormir(50 * tentativa);
      }
    }
  }
}