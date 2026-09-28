import type { ICotaCrua } from "@shared/interfaces/cota.interface";

/**
 * Valida o shape basico do payload da Aurora sem inventar dados.
 */
export function ehCotaCrua(valor: unknown): valor is ICotaCrua {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    return false;
  }

  const v = valor as Record<string, unknown>;
  const textoValido = (campo: unknown) =>
    campo === undefined || campo === null || typeof campo === "string";
  const numeroValido = (campo: unknown) =>
    campo === undefined || campo === null || typeof campo === "number";

  return (
    textoValido(v.grupo) &&
    textoValido(v.numero) &&
    textoValido(v.situacao) &&
    numeroValido(v.valorCredito)
  );
}
