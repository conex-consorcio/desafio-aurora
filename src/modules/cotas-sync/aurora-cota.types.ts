/**
 * Shape CRU do detalhe da cota, como chega da Aurora. Tudo opcional: "o
 * contrato diz que e obrigatorio" nao e garantia de nada. Ver ADR-0001.
 */
export interface CotaRaw {
  grupo?: string | null;
  numero?: string | null;
  situacao?: string | null;
  /** Em CENTAVOS: o payload real traz 8990000 para um automovel. */
  valorCredito?: number | null;
}

export function ehCotaRaw(valor: unknown): valor is CotaRaw {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return false;
  }
  const v = valor as Record<string, unknown>;
  const textoOk = (x: unknown) =>
    x === undefined || x === null || typeof x === "string";
  const numeroOk = (x: unknown) =>
    x === undefined || x === null || typeof x === "number";

  return (
    textoOk(v.grupo) &&
    textoOk(v.numero) &&
    textoOk(v.situacao) &&
    numeroOk(v.valorCredito)
  );
}
