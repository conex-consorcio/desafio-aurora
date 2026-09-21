import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@shared/prisma/prisma.service";
import { AuroraClient } from "@shared/aurora/aurora.client";

@Injectable()
export class CotasSyncService {
  private readonly logger = new Logger(CotasSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aurora: AuroraClient,
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
      numeros.map((numero) => this.aurora.detalheCota(grupo, numero)),
    );

    for (const detalhe of detalhes) {
      await this.prisma.cota.create({
        data: {
          grupo: detalhe.grupo,
          numero: detalhe.numero,
          situacao: detalhe.situacao,
          valorCredito: detalhe.valorCredito,
          sincronizadaEm: new Date(),
        },
      });
    }

    this.logger.log(`grupo ${grupo}: ${detalhes.length} cotas sincronizadas`);

    return detalhes.length;
  }
}
