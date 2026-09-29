import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { PrismaService } from "@shared/prisma/prisma.service";
import { AuroraClient } from "@shared/aurora/aurora.client";
import { LimiteGlobal } from "@shared/concurrency/limite-global";
import { mapWithConcurrency } from "@shared/concurrency/map-with-concurrency";

@Injectable()
export class CotasSyncService implements OnApplicationShutdown {
  private readonly logger = new Logger(CotasSyncService.name);
  private readonly concurrency: number;
  private draining = false;
  private readonly emVoo = new Set<Promise<number>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aurora: AuroraClient,
    private readonly limiteGlobal: LimiteGlobal,
  ) {
    this.concurrency = CotasSyncService.concurrencyFromEnv();
  }

  /**
   * Chamado pelo NestJS durante o apagado (SIGTERM/SIGINT). Não despachamos
   * mais consultas; as que estão em voo terminam, limitadas pelo timeout.
   */
  onApplicationShutdown(): void {
    this.logger.log("apagando: drenando sincronizacoes em voo");
    this.draining = true;
  }

  /**
   * Apagado ordenado: marca a drenagem e espera que as sincronizacoes em voo
   * terminem (lançam e não persistem nada). Quem chama isto decide quando
   * fechar o servidor.
   */
  async terminar(): Promise<void> {
    this.onApplicationShutdown();
    await Promise.allSettled([...this.emVoo]);
  }

  /**
   * Sincroniza o roster inteiro de um grupo com a Aurora.
   *
   * Um grupo tem 500 cotas. Precisamos do detalhe de cada uma, sem derrubar
   * o parceiro: nunca mais de `concurrency` requests simultáneas.
   */
  async sincronizarGrupo(grupo: string, total = 500): Promise<number> {
    const promessa = this.runSincronizacao(grupo, total);
    this.emVoo.add(promessa);
    try {
      return await promessa;
    } finally {
      this.emVoo.delete(promessa);
    }
  }

  private async runSincronizacao(grupo: string, total: number): Promise<number> {
    const numeros = Array.from({ length: total }, (_, i) =>
      String(i + 1).padStart(4, "0"),
    );

    const detalhes = await mapWithConcurrency(
      numeros,
      this.concurrency,
      (numero) => this.conLimiteGlobal(() => this.aurora.detalheCota(grupo, numero)),
      () => this.draining,
    );

    await this.prisma.$transaction((tx) =>
      tx.cota.createMany({
        data: detalhes.map((detalhe) => ({
          grupo: detalhe.grupo,
          numero: detalhe.numero,
          situacao: detalhe.situacao,
          valorCredito: detalhe.valorCredito,
          sincronizadaEm: new Date(),
        })),
      }),
    );

    this.logger.log(`grupo ${grupo}: ${detalhes.length} cotas sincronizadas`);

    return detalhes.length;
  }

  /**
   * Reserva um slot do limite GLOBAL (compartilhado entre instancias) para
   * uma request ao parceiro, e o libera ao terminar. É o que mantém o
   * agregado de todos os pods abaixo do limite do parceiro.
   */
  private async conLimiteGlobal<T>(executar: () => Promise<T>): Promise<T> {
    const token = await this.limiteGlobal.adquirir(() => this.draining);
    try {
      return await executar();
    } finally {
      await this.limiteGlobal.liberar(token);
    }
  }

  private static concurrencyFromEnv(): number {
    const value = Number(process.env.AURORA_CONCURRENCIA ?? 16);
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(
        `AURORA_CONCURRENCIA invalida: ${process.env.AURORA_CONCURRENCIA}`,
      );
    }
    return value;
  }
}