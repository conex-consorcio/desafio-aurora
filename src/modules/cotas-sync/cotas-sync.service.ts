import { Inject, Injectable, Logger } from "@nestjs/common";
import { ContractViolationError } from "@shared/http/contract-violation.error";
import { PrismaService } from "@shared/prisma/prisma.service";
import { ehCotaRaw } from "./aurora-cota.types";
import { paraCotaDetalhe, type CotaDetalhe } from "./cota.view-model";

export const COTA_FONTE = "COTA_FONTE";

/** Porta. O service depende disto, nao do cliente HTTP da Aurora. */
export interface CotaFonte {
  buscar(grupo: string, numero: string): Promise<unknown>;
}

@Injectable()
export class CotasSyncService {
  private readonly logger = new Logger(CotasSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(COTA_FONTE) private readonly fonte: CotaFonte,
  ) {}

  /**
   * Sincroniza o roster inteiro de um grupo com a Aurora.
   *
   * Um grupo tem 500 cotas. Precisamos do detalhe de cada uma.
   */
  async sincronizarGrupo(grupo: string, total = 500): Promise<number> {
    const numeros = Array.from({ length: total }, (_, i) =>
      String(i + 1).padStart(4, "0"),
    );

    const detalhes = await Promise.all(
      numeros.map((numero) => this.buscarDetalhe(grupo, numero)),
    );

    for (const detalhe of detalhes) {
      await this.prisma.cota.create({
        data: {
          grupo: detalhe.grupo,
          numero: detalhe.numero,
          situacao: detalhe.situacao,
          // null = o parceiro nao informou. Zero seria uma afirmacao dele.
          valorCredito: detalhe.valorCredito ?? null,
          sincronizadaEm: new Date(),
        },
      });
    }

    this.logger.log(`grupo ${grupo}: ${detalhes.length} cotas sincronizadas`);

    return detalhes.length;
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
}
