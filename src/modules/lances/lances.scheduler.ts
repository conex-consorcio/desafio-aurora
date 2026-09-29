import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { LancesWorker } from "./lances.worker";

/**
 * Dia 1 de cada mes, 06:00: registra o lance de toda cota elegible.
 *
 * Este scheduler roda em TODA instancia da aplicacao. O trabalho se reparte
 * via a fila de Redis: so uma instancia le o banco e cada cota a
 * processa um unico worker.
 */
@Injectable()
export class LancesScheduler {
  private readonly logger = new Logger(LancesScheduler.name);

  constructor(private readonly worker: LancesWorker) {}

  @Cron("0 6 1 * *")
  async registrarLancesDoMes(): Promise<void> {
    const mes = assembleiaDoMes();
    this.logger.log(`iniciando lances do mes ${mes}`);
    await this.worker.rodar(mes);
  }
}

export function assembleiaDoMes(referencia = new Date()): string {
  const ano = referencia.getUTCFullYear();
  const mes = String(referencia.getUTCMonth() + 1).padStart(2, "0");
  return `${ano}-${mes}`;
}