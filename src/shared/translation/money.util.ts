/**
 * Traducao monetaria.
 *
 * Guardamos dinheiro em CENTAVOS, sempre, em inteiro. A unidade que o parceiro
 * usa e decidida POR ENDPOINT, verificando o payload real -- nunca por analogia
 * com outro campo de nome parecido.
 */

/** O parceiro mandou reais; convertemos para centavos. */
export function reaisParaCentavos(valor?: number | null): number | undefined {
  if (valor === undefined || valor === null || !Number.isFinite(valor)) {
    return undefined;
  }
  return Math.round(valor * 100);
}

/** O parceiro ja mandou centavos; so normalizamos para inteiro. */
export function centavosDireto(valor?: number | null): number | undefined {
  if (valor === undefined || valor === null || !Number.isFinite(valor)) {
    return undefined;
  }
  return Math.round(valor);
}
