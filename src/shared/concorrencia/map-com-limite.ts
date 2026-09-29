export async function mapComLimite<T, R>(
  itens: readonly T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(itens.length);
  let proximo = 0;
  let abortado = false;

  async function trabalhador(): Promise<void> {
    while (!abortado) {
      const indice = proximo++;
      if (indice >= itens.length) return;

      try {
        resultados[indice] = await fn(itens[indice]!, indice);
      } catch (erro) {
        abortado = true;
        throw erro;
      }
    }
  }

  const trabalhadores = Math.max(1, Math.min(limite, itens.length));
  await Promise.all(Array.from({ length: trabalhadores }, trabalhador));

  return resultados;
}