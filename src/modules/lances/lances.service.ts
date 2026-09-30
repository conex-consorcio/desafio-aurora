import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma, SituacaoLance } from "@prisma/client";
import { ContractViolationError } from "@shared/http/contract-violation.error";
import { ParceiroFalhaError } from "@shared/http/parceiro-falha.error";
import { PrismaService } from "@shared/prisma/prisma.service";
import { ehLanceRegistradoRaw } from "./aurora-lance.types";
import { paraLanceRegistrado, type LanceRegistrado } from "./lance.view-model";

export interface RegistrarLanceInput {
  grupo: string;
  cota: string;
  assembleia: string;
}

export type RegistrarLanceResultado =
  | { situacao: "REGISTRADO"; protocolo: string; jaRegistrado: boolean }
  /** Outra chamada reservou a chave e ainda nao concluiu dentro do prazo. */
  | { situacao: "PENDENTE" };

export interface RegistrarLanceOpcoes {
  /**
   * Quando outra chamada ja reservou a chave: esperar o protocolo dela
   * (padrao, quem chama quer a resposta) ou devolver PENDENTE na hora (o
   * scheduler, que so precisa garantir que alguem registrou).
   */
  aguardarConcorrente?: boolean;
}

export const LANCE_REGISTRADOR = "LANCE_REGISTRADOR";

/** Porta. O service depende disto, nao do cliente HTTP da Aurora. */
export interface LanceRegistrador {
  registrar(input: RegistrarLanceInput): Promise<unknown>;
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
  async registrar(
    input: RegistrarLanceInput,
    opcoes: RegistrarLanceOpcoes = {},
  ): Promise<RegistrarLanceResultado> {
    const souDono = await this.reservar(input);

    if (!souDono) {
      return opcoes.aguardarConcorrente === false
        ? { situacao: "PENDENTE" }
        : this.aguardarDono(input);
    }

    const resposta = await this.registrarComoDono(input);

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

  /**
   * Chama o parceiro segurando a reserva.
   *
   * Se a falha aconteceu antes de a requisicao sair, a reserva e apagada e a
   * chave volta a ficar disputavel. Se pode ter saido, a reserva fica
   * PENDENTE: repetir poderia cobrar duas vezes, e a Aurora nao tem consulta
   * nem chave de idempotencia para tirar a duvida. Alguem olha depois.
   */
  private async registrarComoDono(input: RegistrarLanceInput): Promise<LanceRegistrado> {
    const contexto = `grupo=${input.grupo} cota=${input.cota} assembleia=${input.assembleia}`;
    let corpo: unknown;

    try {
      corpo = await this.registrador.registrar(input);
    } catch (erro) {
      if (erro instanceof ParceiroFalhaError && !erro.efeitoDesconhecido) {
        await this.prisma.lance.delete({ where: { grupo_cota_assembleia: input } });
        this.logger.warn(`reserva liberada, requisicao nao saiu ${contexto}: ${erro.message}`);
      } else {
        this.logger.error(`reserva mantida PENDENTE, efeito desconhecido ${contexto}`);
      }
      throw erro;
    }

    // Daqui em diante a Aurora respondeu 2xx: o lance existe la, cobrado. Uma
    // resposta fora do contrato nao desfaz isso; a reserva fica PENDENTE para
    // alguem reconciliar, e nunca e apagada.
    const confirmacao = ehLanceRegistradoRaw(corpo) ? paraLanceRegistrado(corpo) : undefined;
    if (!confirmacao) {
      this.logger.error(`reserva mantida PENDENTE, confirmacao fora do contrato ${contexto}`);
      throw new ContractViolationError("registrarLance", "confirmacao sem protocolo");
    }

    if (confirmacao.vezRegistrada !== undefined && confirmacao.vezRegistrada > 1) {
      // O parceiro esta dizendo que ja tinha este lance: houve duplicata em
      // algum lugar (antes desta protecao, ou fora dela). Nao e para acontecer.
      this.logger.error(`parceiro acusa duplicata vezRegistrada=${confirmacao.vezRegistrada} ${contexto}`);
    }

    return confirmacao;
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
