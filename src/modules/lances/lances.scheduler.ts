import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@shared/prisma/prisma.service";
import { LancesService } from "./lances.service";

/**
 * Dia 1 de cada mes, 06:00: registra o lance de toda cota elegivel.
 *
 * Este scheduler roda em TODA instancia da aplicacao. A garantia de um lance
 * por cota nao esta aqui: esta na reserva feita por LancesService. Aqui cada
 * instancia so tenta; quem perde a reserva de uma cota segue para a proxima
 * sem esperar, e um erro numa cota nao impede as demais.
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
    const assembleia = assembleiaDoMes();

    this.logger.log(`registrando lances de ${cotas.length} cotas assembleia=${assembleia}`);

    let registradas = 0;
    let falhas = 0;

    for (const cota of cotas) {
      try {
        const resultado = await this.lances.registrar(
          { grupo: cota.grupo, cota: cota.numero, assembleia },
          { aguardarConcorrente: false },
        );
        if (resultado.situacao === "REGISTRADO" && !resultado.jaRegistrado) registradas += 1;
      } catch (erro) {
        falhas += 1;
        const motivo = erro instanceof Error ? erro.message : String(erro);
        this.logger.error(`falha na cota grupo=${cota.grupo} cota=${cota.numero}: ${motivo}`);
      }
    }

    this.logger.log(
      `lances do mes: ${registradas} registradas por esta instancia, ${falhas} falhas, ${cotas.length} cotas`,
    );
  }
}

export function assembleiaDoMes(referencia = new Date()): string {
  const ano = referencia.getUTCFullYear();
  const mes = String(referencia.getUTCMonth() + 1).padStart(2, "0");
  return `${ano}-${mes}`;
}
