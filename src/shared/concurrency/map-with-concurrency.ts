import { Semaphore } from "./semaphore";

/**
 * Interrompemos o trabalho antes de completar — geralmente porque o pod
 * recebeu SIGTERM. In-flight terminou; o que não começou, não começa.
 */
export class ConcurrencyInterruptedError extends Error {
  constructor(completed: number, total: number) {
    super(`work interrupted: ${completed}/${total} items completed`);
    this.name = "ConcurrencyInterruptedError";
  }
}

/**
 * Corre `map` sobre `items` com, no máximo, `concurrency` promises ativas.
 *
 * Quando `isInterrupted` devolve true, as tarefas ainda não iniciadas não
 * são despachadas e o resultado é `ConcurrencyInterruptedError`. As que já
 * estão em voo terminam (limitadas pelo timeout de cada request).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
  isInterrupted: () => boolean = () => false,
): Promise<R[]> {
  const semaphore = new Semaphore(concurrency);
  const results = new Array<R | undefined>(items.length);
  const jobs = items.map<{ item: T; index: number }>((item, index) => ({
    item,
    index,
  }));
  let nextJob = 0;
  let interrupted = false;

  async function worker(): Promise<void> {
    for (;;) {
      const job = jobs[nextJob];
      nextJob += 1;

      if (job === undefined) return;
      if (isInterrupted()) {
        interrupted = true;
        return;
      }

      await semaphore.acquire();
      try {
        results[job.index] = await map(job.item);
      } finally {
        semaphore.release();
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  if (interrupted) {
    const completed = results.filter((result) => result !== undefined).length;
    throw new ConcurrencyInterruptedError(completed, items.length);
  }

  return results as R[];
}