import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@shared/prisma/prisma.service";
import { AuroraClient } from "@shared/aurora/aurora.client";
import { RedisService } from "@shared/redis/redis.service";
import { ContractViolationError } from "@shared/http/contract-violation.error";

export interface RegistrarLanceInput {
  grupo: string;
  cota: string;
  assembleia: string;
}

export interface RegistrarLanceResultado {
  protocolo: string;
  jaRegistrado: boolean;
}

@Injectable()
export class LancesService {
  private readonly logger = new Logger(LancesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aurora: AuroraClient,
    private readonly redis: RedisService,
  ) { }

  /**
   * Registra o lance da cota na assembleia do mes.
   *
   * O lance so pode ser registrado UMA vez por cota por assembleia: o parceiro
   * cobra por lance e nao faz idempotencia do lado dele.
   *
   * Protegido por lock distribuido granular no Redis para evitar janelas
   * de corrida (check-then-act) entre multiplas instancias concorrentes.
   */
  async registrar(input: RegistrarLanceInput): Promise<RegistrarLanceResultado> {
    const cacheKey = `protocolo:lance:${input.grupo}:${input.cota}:${input.assembleia}`;
    const lockKey = `lock:lance:${input.grupo}:${input.cota}:${input.assembleia}`;

    // 1. Verificacao rapida no cache Redis
    const protocoloEmCache = await this.redis.obter(cacheKey);
    if (protocoloEmCache) {
      return { protocolo: protocoloEmCache, jaRegistrado: true };
    }

    // 2. Verificacao no banco de dados (Postgres)
    const existenteNoBanco = await this.prisma.lance.findFirst({
      where: {
        grupo: input.grupo,
        cota: input.cota,
        assembleia: input.assembleia,
        protocolo: { not: null },
      },
    });

    if (existenteNoBanco?.protocolo) {
      await this.redis.definir(cacheKey, existenteNoBanco.protocolo, "EX", 300);
      return { protocolo: existenteNoBanco.protocolo, jaRegistrado: true };
    }

    // 3. Tentativa de adquirir o lock granular distribuido (TTL de 10s)
    const lockTtlMs = 10000;
    const { adquirido, idDono } = await this.redis.adquirirBloqueio(lockKey, lockTtlMs);

    if (adquirido) {
      try {
        // Double-check no banco apos adquirir o lock (evita race se acabou de ser persistido)
        const recheck = await this.prisma.lance.findFirst({
          where: {
            grupo: input.grupo,
            cota: input.cota,
            assembleia: input.assembleia,
            protocolo: { not: null },
          },
        });
        if (recheck?.protocolo) {
          await this.redis.definir(cacheKey, recheck.protocolo, "EX", 300);
          return { protocolo: recheck.protocolo, jaRegistrado: true };
        }

        // 4. Chamada externa a Aurora (efeito irreversivel do parceiro)
        const resposta = await this.aurora.registrarLance(input);

        if (
          !resposta ||
          typeof resposta.protocolo !== "string" ||
          resposta.protocolo.trim() === ""
        ) {
          throw new ContractViolationError(
            "registrarLance",
            "resposta sem protocolo valido",
          );
        }

        // 5. Persistencia no banco local
        await this.prisma.lance.create({
          data: {
            grupo: input.grupo,
            cota: input.cota,
            assembleia: input.assembleia,
            protocolo: resposta.protocolo,
          },
        });

        // 6. Atualizacao no cache para liberacao imediata dos concorrentes
        await this.redis.definir(cacheKey, resposta.protocolo, "EX", 300);

        this.logger.log(
          `lance registrado grupo=${input.grupo} cota=${input.cota} protocolo=${resposta.protocolo}`,
        );

        return { protocolo: resposta.protocolo, jaRegistrado: false };
      } finally {
        await this.redis.liberarBloqueio(lockKey, idDono);
      }
    }

    // 7. Chamador concorrente: aguarda a conclusao pelo lider
    return this.aguardarResolucao(input, cacheKey, lockKey);
  }

  private async aguardarResolucao(
    input: RegistrarLanceInput,
    cacheKey: string,
    lockKey: string,
  ): Promise<RegistrarLanceResultado> {
    const inicio = Date.now();
    const maxEsperaMs = 15000;
    const intervaloMs = 40;

    while (Date.now() - inicio < maxEsperaMs) {
      await new Promise((resolve) => setTimeout(resolve, intervaloMs));

      // Verifica se o resultado ja foi colocado em cache
      const protoCache = await this.redis.obter(cacheKey);
      if (protoCache) {
        return { protocolo: protoCache, jaRegistrado: true };
      }

      // Verifica se foi persistido no banco
      const existente = await this.prisma.lance.findFirst({
        where: {
          grupo: input.grupo,
          cota: input.cota,
          assembleia: input.assembleia,
          protocolo: { not: null },
        },
      });
      if (existente?.protocolo) {
        await this.redis.definir(cacheKey, existente.protocolo, "EX", 300);
        return { protocolo: existente.protocolo, jaRegistrado: true };
      }

      // Se o lock expirou ou foi liberado sem gravar no banco (ex: crash do lider),
      // este no assume a lideranca tentando registrar novamente
      const lockAindaExiste = await this.redis.existe(lockKey);
      if (!lockAindaExiste) {
        return this.registrar(input);
      }
    }

    throw new Error(
      `Timeout aguardando registro de lance concorrente grupo=${input.grupo} cota=${input.cota}`,
    );
  }
}