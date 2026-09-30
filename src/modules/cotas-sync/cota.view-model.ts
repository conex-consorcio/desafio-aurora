import { centavosDireto } from "@shared/translation/money.util";
import type { CotaRaw } from "./aurora-cota.types";

/** O que a NOSSA aplicacao enxerga. O shape do parceiro morre aqui. */
export interface CotaDetalhe {
  grupo: string;
  numero: string;
  situacao: string;
  /** Centavos. Ausente quando o parceiro nao informou -- nunca zero. */
  valorCredito?: number;
}

function texto(valor?: string | null): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : undefined;
}

/** Sem grupo, numero e situacao nao ha cota; nao inventamos nenhum deles. */
export function paraCotaDetalhe(raw: CotaRaw): CotaDetalhe | undefined {
  const grupo = texto(raw.grupo);
  const numero = texto(raw.numero);
  const situacao = texto(raw.situacao);
  if (!grupo || !numero || !situacao) return undefined;

  const valorCredito = centavosDireto(raw.valorCredito);

  return {
    grupo,
    numero,
    situacao,
    ...(valorCredito !== undefined && { valorCredito }),
  };
}
