/**
 * Shape CRU do parceiro, como chega da Aurora. Tudo opcional: "o contrato diz
 * que e obrigatorio" nao e garantia de nada. Ver ADR-0001.
 */
export interface ParceiroRaw {
  codigo?: string | null;
  razaoSocial?: string | null;
  documento?: string | null;
  comissaoPercentual?: number | null;
}

export function ehParceiroRaw(valor: unknown): valor is ParceiroRaw {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return false;
  }
  const v = valor as Record<string, unknown>;
  const textoOk = (x: unknown) =>
    x === undefined || x === null || typeof x === "string";
  const numeroOk = (x: unknown) =>
    x === undefined || x === null || typeof x === "number";

  return (
    textoOk(v.codigo) &&
    textoOk(v.razaoSocial) &&
    textoOk(v.documento) &&
    numeroOk(v.comissaoPercentual)
  );
}
