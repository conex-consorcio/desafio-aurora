/**
 * Shape CRU da confirmacao de lance, como chega da Aurora. Tudo opcional.
 * Ver ADR-0001.
 */
export interface LanceRegistradoRaw {
  protocolo?: string | null;
  /** Quantas vezes ESTA cota ja foi registrada la. Maior que 1 = duplicata. */
  vezRegistrada?: number | null;
}

export function ehLanceRegistradoRaw(valor: unknown): valor is LanceRegistradoRaw {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return false;
  }
  const v = valor as Record<string, unknown>;
  const textoOk = (x: unknown) =>
    x === undefined || x === null || typeof x === "string";
  const numeroOk = (x: unknown) =>
    x === undefined || x === null || typeof x === "number";

  return textoOk(v.protocolo) && numeroOk(v.vezRegistrada);
}
