/**
 * Semáforo simples para limitar concorrencia sobre efeito externo.
 *
 * A Aurora não aguanta mais de N requisições simultaneas. Este semáforo é o
 * que impede que a sincronizacao dispare as 500 cotas de uma vez.
 */
export class Semaphore {
  private available: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isFinite(permits) || permits < 1) {
      throw new Error(`Semaphore needs at least 1 permit, got ${permits}`);
    }
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }

    await new Promise<void>((release) => {
      this.waiting.push(release);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}