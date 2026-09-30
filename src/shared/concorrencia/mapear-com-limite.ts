/**
 * Aplica `tarefa` a cada item com no maximo `limite` execucoes simultaneas.
 *
 * E um pool de trabalhadores puxando de uma fila compartilhada: sem lote,
 * sem espera pelo mais lento do grupo. Promise.all sobre 500 itens abre 500
 * conexoes; isto abre `limite`.
 *
 * Se `parar` for acionado, os trabalhadores terminam o item em maos e nao
 * pegam outro. Os itens que ficaram sem tarefa sao devolvidos.
 */
export async function mapearComLimite<T>(
  itens: readonly T[],
  limite: number,
  tarefa: (item: T) => Promise<void>,
  parar?: AbortSignal,
): Promise<{ naoIniciados: T[] }> {
  if (!Number.isInteger(limite) || limite < 1) {
    throw new RangeError(`limite de concorrencia invalido: ${limite}`);
  }

  let proximo = 0;

  async function trabalhador(): Promise<void> {
    while (proximo < itens.length && !parar?.aborted) {
      const item = itens[proximo];
      proximo += 1;
      if (item !== undefined) await tarefa(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limite, itens.length) }, trabalhador),
  );

  return { naoIniciados: itens.slice(proximo) };
}
