import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma, SituacaoLance } from "@prisma/client";
import { PrismaService } from "@shared/prisma/prisma.service";

export interface RegistrarLanceInput {
  grupo: string;
  cota: string;
  assembleia: string;
}

export type RegistrarLanceResultado =
  | { situacao: "REGISTRADO"; protocolo: string; jaRegistrado: boolean }
  /** Outra chamada reservou a chave e ainda nao concluiu dentro do prazo. */
  | { situacao: "PENDENTE" };

export const LANCE_REGISTRADOR = "LANCE_REGISTRADOR";

/** Porta. O service depende disto, nao do cliente HTTP da Aurora. */
export interface LanceRegistrador {
  registrar(input: RegistrarLanceInput): Promise<{ protocolo: string }>;
}

export const ESPERA_POR_CONCORRENTE = "ESPERA_POR_CONCORRENTE";

/** Quanto quem perdeu a reserva espera pelo protocolo de quem ganhou. */
export interface EsperaPorConcorrente {
  intervaloMs: number;
  prazoMs: number;
}

/** O dono leva ~300ms na Aurora, mais uma renovacao de token no pior caso. */
const ESPERA_PADRAO: EsperaPorConcorrente = { intervaloMs: 150, prazoMs: 15_000 };

@Injectable()
export class LancesService {
  private readonly logger = new Logger(LancesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LANCE_REGISTRADOR) private readonly registrador: LanceRegistrador,
    @Optional()
    @Inject(ESPERA_POR_CONCORRENTE)
    private readonly espera: EsperaPorConcorrente = ESPERA_PADRAO,
  ) {}

  /**
   * Registra o lance da cota na assembleia do mes.
   *
   * O lance so pode ser registrado UMA vez por cota por assembleia: o parceiro
   * cobra por lance e nao faz idempotencia do lado dele. Por isso a chave e
   * reservada no banco ANTES da chamada: quem consegue inserir a linha e o
   * unico que fala com a Aurora; os demais esperam o protocolo aparecer.
   */
  async registrar(input: RegistrarLanceInput): Promise<RegistrarLanceResultado> {
    const souDono = await this.reservar(input);

    if (!souDono) {
      return this.aguardarDono(input);
    }

    const resposta = await this.registrador.registrar(input);

    await this.prisma.lance.update({
      where: { grupo_cota_assembleia: input },
      data: {
        situacao: SituacaoLance.REGISTRADO,
        protocolo: resposta.protocolo,
        registradoEm: new Date(),
      },
    });

    this.logger.log(`lance registrado grupo=${input.grupo} cota=${input.cota}`);

    return { situacao: "REGISTRADO", protocolo: resposta.protocolo, jaRegistrado: false };
  }

  /** Tenta inserir a reserva. `false` quando outra chamada chegou antes. */
  private async reservar(input: RegistrarLanceInput): Promise<boolean> {
    try {
      await this.prisma.lance.create({ data: input });
      return true;
    } catch (erro) {
      if (ehViolacaoDeUnicidade(erro)) return false;
      throw erro;
    }
  }

  /**
   * Espera o dono da reserva concluir e devolve o protocolo dele. Se a reserva
   * sumir (o dono desistiu antes de chamar o parceiro), disputa de novo.
   */
  private async aguardarDono(input: RegistrarLanceInput): Promise<RegistrarLanceResultado> {
    const limite = Date.now() + this.espera.prazoMs;

    while (true) {
      const lance = await this.prisma.lance.findUnique({
        where: { grupo_cota_assembleia: input },
      });

      if (!lance) return this.registrar(input);

      if (lance.situacao === SituacaoLance.REGISTRADO && lance.protocolo) {
        return { situacao: "REGISTRADO", protocolo: lance.protocolo, jaRegistrado: true };
      }

      if (Date.now() >= limite) {
        this.logger.warn(
          `reserva pendente alem do prazo grupo=${input.grupo} cota=${input.cota} assembleia=${input.assembleia}`,
        );
        return { situacao: "PENDENTE" };
      }

      await dormir(this.espera.intervaloMs);
    }
  }
}

function ehViolacaoDeUnicidade(erro: unknown): boolean {
  return erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === "P2002";
}

function dormir(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}
