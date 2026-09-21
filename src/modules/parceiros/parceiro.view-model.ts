import type { ParceiroRaw } from "./aurora-parceiro.types";

/** O que a NOSSA aplicacao enxerga. O shape do parceiro morre aqui. */
export interface Parceiro {
  codigo: string;
  razaoSocial?: string;
  documento?: string;
  /** Base 10000: 3,75% vira 375. Percentual em float da ruim. */
  comissaoBasisPoints?: number;
}

function texto(valor?: string | null): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : undefined;
}

export function paraParceiro(raw: ParceiroRaw): Parceiro | undefined {
  const codigo = texto(raw.codigo);
  // Sem codigo nao ha identidade, e nao inventamos uma.
  if (!codigo) return undefined;

  const percentual = raw.comissaoPercentual;
  const comissao =
    percentual === undefined || percentual === null || !Number.isFinite(percentual)
      ? undefined
      : Math.round(percentual * 100);

  const razaoSocial = texto(raw.razaoSocial);
  const documento = texto(raw.documento);

  return {
    codigo,
    ...(razaoSocial !== undefined && { razaoSocial }),
    ...(documento !== undefined && { documento }),
    ...(comissao !== undefined && { comissaoBasisPoints: comissao }),
  };
}
