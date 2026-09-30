import type { LanceRegistradoRaw } from "./aurora-lance.types";

/** O que a NOSSA aplicacao enxerga da confirmacao. O shape do parceiro morre aqui. */
export interface LanceRegistrado {
  protocolo: string;
  /** Ausente quando o parceiro nao informou. */
  vezRegistrada?: number;
}

/** Sem protocolo nao ha confirmacao; nao inventamos um. */
export function paraLanceRegistrado(raw: LanceRegistradoRaw): LanceRegistrado | undefined {
  const protocolo = raw.protocolo?.trim();
  if (!protocolo) return undefined;

  const vez = raw.vezRegistrada;
  const vezRegistrada =
    vez === undefined || vez === null || !Number.isFinite(vez) ? undefined : vez;

  return { protocolo, ...(vezRegistrada !== undefined && { vezRegistrada }) };
}
