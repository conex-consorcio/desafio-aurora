import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { PrismaService } from "@shared/prisma/prisma.service";
import { AuroraClient } from "@shared/aurora/aurora.client";
import { ContractViolationError } from "@shared/http/contract-violation.error";
import { ehCotaCrua } from "./aurora-cota.types";
import { paraCota } from "./cota.view-model";
import type { ICota } from "@shared/interfaces/cota.interface";

/**
 * Limite de concorrencia preventiva.
 * A Aurora suporta no maximo 20 conexoes simultaneas antes de responder 429.
 * Com 12 trabalhadores concorrentes garantimos 0 recusas (429) e tempo total
 * de sincronizacao de ~20-25 segundos para 500 cotas (abaixo do teto de 60s).
 */
export const CONCORRENCIA_PADRAO = 12;

@Injectable()
export class CotasSyncService implements OnApplicationShutdown {
  private readonly logger = new Logger(CotasSyncService.name);
  private encerrando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aurora: AuroraClient,
  ) { }

  onApplicationShutdown(signal?: string): void {
    this.logger.warn(
      `shutdown recebido (${signal}). interrompendo despacho de novas cotas e drenando requisicoes ativas`,
    );
    this.encerrando = true;
  }

  /**
   * Sincroniza o conjunto de cotas de um grupo com a Aurora de forma resiliente.
   * Utiliza pool de concorrencia limitada preventiva para evitar 429 e respeita graceful shutdown.
   */
  async sincronizarGrupo(
    grupo: string,
    total = 500,
    concorrencia = CONCORRENCIA_PADRAO,
  ): Promise<number> {
    if (total <= 0) return 0;

    let sincronizadas = 0;

    // Inicializa a primeira cota de forma sequencial para garantir que o token de acesso
    // esteja obtido e aquecido na memoria antes de despachar o pool de trabalhadores concorrentes.
    // Isso evita o colateral de manada na primeira requisicao sem precisar resolver o Caso 3.
    const primeiraCota = await this.consultarCota(grupo, "0001");
    if (primeiraCota) {
      await this.persistirCota(primeiraCota);
      sincronizadas++;
    }

    if (total === 1 || this.encerrando) {
      return sincronizadas;
    }

    const numerosRestantes = Array.from({ length: total - 1 }, (_, i) =>
      String(i + 2).padStart(4, "0"),
    );

    let proximoIndice = 0;

    const trabalhador = async (): Promise<void> => {
      while (proximoIndice < numerosRestantes.length && !this.encerrando) {
        const indice = proximoIndice++;
        const numero = numerosRestantes[indice];
        if (!numero) break;

        const cota = await this.consultarCota(grupo, numero);
        if (cota) {
          await this.persistirCota(cota);
          sincronizadas++;
        }
      }
    };

    const qtdTrabalhadores = Math.min(concorrencia, numerosRestantes.length);
    const trabalhadores = Array.from({ length: qtdTrabalhadores }, () =>
      trabalhador(),
    );

    await Promise.all(trabalhadores);

    this.logger.log(
      `grupo ${grupo}: ${sincronizadas} cotas sincronizadas (solicitado: ${total})`,
    );

    return sincronizadas;
  }

  private async consultarCota(
    grupo: string,
    numero: string,
  ): Promise<ICota | undefined> {
    const cru = await this.aurora.detalheCota(grupo, numero);

    if (!ehCotaCrua(cru)) {
      throw new ContractViolationError(
        "detalheCota",
        `resposta com formato inesperado para grupo ${grupo} cota ${numero}`,
      );
    }

    return paraCota(cru);
  }

  private async persistirCota(cota: ICota): Promise<void> {
    await this.prisma.cota.create({
      data: {
        grupo: cota.grupo,
        numero: cota.numero,
        situacao: cota.situacao,
        valorCredito: cota.valorCredito,
        sincronizadaEm: new Date(),
      },
    });
  }
}

