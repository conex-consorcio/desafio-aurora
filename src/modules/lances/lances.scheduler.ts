import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@shared/prisma/prisma.service";
import { LancesService } from "./lances.service";

/**
 * Dia 1 de cada mes, 06:00: registra o lance de toda cota elegivel.
 *
 * Este scheduler roda em TODA instancia da aplicacao.
 */
@Injectable()
export class LancesScheduler {
  private readonly logger = new Logger(LancesScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lances: LancesService,
  ) {}

  @Cron("0 6 1 * *")
  async registrarLancesDoMes(): Promise<void> {
    const cotas = await this.prisma.cota.findMany({
      where: { situacao: "DISPONIVEL" },
    });

    this.logger.log(`registrando lances de ${cotas.length} cotas`);

    for (const cota of cotas) {
      await this.lances.registrar({
        grupo: cota.grupo,
        cota: cota.numero,
        assembleia: assembleiaDoMes(),
      });
    }
  }
}

export function assembleiaDoMes(referencia = new Date()): string {
  const ano = referencia.getUTCFullYear();
  const mes = String(referencia.getUTCMonth() + 1).padStart(2, "0");
  return `${ano}-${mes}`;
}
