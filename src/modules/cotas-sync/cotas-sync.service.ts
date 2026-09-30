import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { mapearComLimite } from "@shared/concorrencia/mapear-com-limite";
import { ContractViolationError } from "@shared/http/contract-violation.error";
import { ParceiroFalhaError } from "@shared/http/parceiro-falha.error";
import { PrismaService } from "@shared/prisma/prisma.service";
import { ehCotaRaw } from "./aurora-cota.types";
import { paraCotaDetalhe, type CotaDetalhe } from "./cota.view-model";

export const COTA_FONTE = "COTA_FONTE";

/** Porta. O service depende disto, nao do cliente HTTP da Aurora. */
export interface CotaFonte {
  buscar(grupo: string, numero: string): Promise<unknown>;
}

export const SYNC_OPCOES = "SYNC_OPCOES";

export interface SyncOpcoes {
  /**
   * Consultas simultaneas ao parceiro POR INSTANCIA. O limite da Aurora e
   * compartilhado por todas as instancias (confirmado em 28/09): em producao
   * este valor precisa caber em limite / instancias.
   */
  limite: number;
  /** Tentativas por cota quando a falha e certamente anterior ao efeito. */
  tentativas: number;
  /** Espera entre tentativas quando o parceiro nao mandou Retry-After. */
  esperaPadraoMs: number;
}

export interface SincronizacaoResultado {
  sincronizadas: number;
  /** Cotas que esgotaram as tentativas. Ausente quando todas sincronizaram. */
  falhas?: string[];
  /** Cotas nem consultadas porque o processo recebeu ordem de desligar. */
  pendentes?: string[];
}

/**
 * Quanto esperamos o que esta em voo ao desligar. Cabe dentro dos 30s de
 * graca padrao do Kubernetes (premissa; nao confirmado com a infra) com
 * folga para o Nest fechar o servidor depois.
 */
const PRAZO_DRENAGEM_MS = 20_000;

const OPCOES_PADRAO: SyncOpcoes = {
  limite: limiteConfigurado(),
  tentativas: 3,
  esperaPadraoMs: 1_000,
};

@Injectable()
export class CotasSyncService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CotasSyncService.name);
  private readonly desligamento = new AbortController();
  private readonly emAndamento = new Set<Promise<SincronizacaoResultado>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COTA_FONTE) private readonly fonte: CotaFonte,
    @Optional() @Inject(SYNC_OPCOES) opcoes: Partial<SyncOpcoes> = {},
  ) {
    this.opcoes = { ...OPCOES_PADRAO, ...opcoes };
  }

  private readonly opcoes: SyncOpcoes;

  /**
   * Sincroniza o roster inteiro de um grupo com a Aurora.
   *
   * Um grupo tem 500 cotas. Precisamos do detalhe de cada uma. Cada cota e
   * gravada assim que chega: uma falha no meio nao perde o que ja veio, e
   * rodar de novo so completa o que falta.
   */
  async sincronizarGrupo(grupo: string, total = 500): Promise<SincronizacaoResultado> {
    const execucao = this.executar(grupo, total);
    this.emAndamento.add(execucao);
    try {
      return await execucao;
    } finally {
      this.emAndamento.delete(execucao);
    }
  }

  /**
   * SIGTERM: nenhuma cota nova e consultada; as que estao em voo terminam e
   * sao gravadas; quem chamou recebe o que deu para fazer. O que ficou fica
   * sem `sincronizadaEm`, e a proxima execucao completa.
   */
  async beforeApplicationShutdown(sinal?: string): Promise<void> {
    if (this.emAndamento.size === 0) return;

    this.logger.warn(
      `${sinal ?? "desligamento"}: drenando ${this.emAndamento.size} sincronizacao(oes) em andamento`,
    );
    this.desligamento.abort();

    await Promise.race([
      Promise.allSettled([...this.emAndamento]),
      dormir(PRAZO_DRENAGEM_MS),
    ]);
  }

  private async executar(grupo: string, total: number): Promise<SincronizacaoResultado> {
    const numeros = Array.from({ length: total }, (_, i) =>
      String(i + 1).padStart(4, "0"),
    );
    const falhas: string[] = [];
    let sincronizadas = 0;

    const { naoIniciados } = await mapearComLimite(
      numeros,
      this.opcoes.limite,
      async (numero) => {
        try {
          const detalhe = await this.buscarComTentativas(grupo, numero);
          await this.gravar(detalhe);
          sincronizadas += 1;
        } catch (erro) {
          falhas.push(numero);
          const motivo = erro instanceof Error ? erro.message : String(erro);
          this.logger.warn(`cota nao sincronizada grupo=${grupo} numero=${numero}: ${motivo}`);
        }
      },
      this.desligamento.signal,
    );

    this.logger.log(
      `grupo ${grupo}: ${sincronizadas} cotas sincronizadas, ${falhas.length} falhas, ${naoIniciados.length} pendentes`,
    );

    return {
      sincronizadas,
      ...(falhas.length > 0 && { falhas }),
      ...(naoIniciados.length > 0 && { pendentes: naoIniciados }),
    };
  }

  /**
   * Repete so quando a falha e certamente anterior ao efeito (429, 5xx,
   * conexao recusada), esperando o que o parceiro pediu. Timeout nao repete:
   * o parceiro pode ter processado, e a consulta contaria duas vezes.
   */
  private async buscarComTentativas(grupo: string, numero: string): Promise<CotaDetalhe> {
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return await this.buscarDetalhe(grupo, numero);
      } catch (erro) {
        const podeRepetir =
          erro instanceof ParceiroFalhaError &&
          !erro.efeitoDesconhecido &&
          tentativa < this.opcoes.tentativas;
        if (!podeRepetir) throw erro;

        await dormir(erro.retryAfterMs ?? this.opcoes.esperaPadraoMs * tentativa);
      }
    }
  }

  private async buscarDetalhe(grupo: string, numero: string): Promise<CotaDetalhe> {
    const corpo = await this.fonte.buscar(grupo, numero);

    if (!ehCotaRaw(corpo)) {
      throw new ContractViolationError("detalheCota", "corpo com shape inesperado");
    }

    const detalhe = paraCotaDetalhe(corpo);
    if (!detalhe) {
      throw new ContractViolationError("detalheCota", "cota sem grupo, numero ou situacao");
    }

    return detalhe;
  }

  private async gravar(detalhe: CotaDetalhe): Promise<void> {
    const dados = {
      situacao: detalhe.situacao,
      // null = o parceiro nao informou. Zero seria uma afirmacao dele.
      valorCredito: detalhe.valorCredito ?? null,
      sincronizadaEm: new Date(),
    };

    await this.prisma.cota.upsert({
      where: { grupo_numero: { grupo: detalhe.grupo, numero: detalhe.numero } },
      create: { grupo: detalhe.grupo, numero: detalhe.numero, ...dados },
      update: dados,
    });
  }
}

/** AURORA_MAX_CONCORRENCIA; 10 quando ausente ou invalido. */
function limiteConfigurado(): number {
  const valor = Number(process.env.AURORA_MAX_CONCORRENCIA);
  return Number.isInteger(valor) && valor > 0 ? valor : 10;
}

function dormir(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}
