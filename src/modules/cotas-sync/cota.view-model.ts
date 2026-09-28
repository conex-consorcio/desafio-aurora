import { Logger } from "@nestjs/common";
import type { ICota, ICotaCrua } from "@shared/interfaces/cota.interface";

const logger = new Logger("CotaViewModel");

function texto(valor?: string | null): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : undefined;
}

/**
 * Traduz o dado cru da Aurora para o modelo de dominio.
 * Respeita estritamente ADR-0002: dado ausente vira undefined, sem inventar zeros.
 */
export function paraCota(crua: ICotaCrua): ICota | undefined {
  const grupo = texto(crua.grupo);
  const numero = texto(crua.numero);
  const situacao = texto(crua.situacao);

  // Sem grupo ou numero nao ha identidade de cota, e situacao e obrigatoria
  if (!grupo || !numero || !situacao) {
    logger.warn("descartando cota com campos essenciais ausentes");
    return undefined;
  }

  let valorCredito: number | undefined;

  if (crua.valorCredito !== undefined && crua.valorCredito !== null) {
    if (typeof crua.valorCredito === "number" && Number.isFinite(crua.valorCredito)) {
      valorCredito = crua.valorCredito;
    } else {
      // Formato inesperado: descarta o campo e emite warning sem dados sensiveis (ADR-0002)
      logger.warn("valorCredito em formato inesperado descartado");
    }
  }

  return {
    grupo,
    numero,
    situacao,
    ...(valorCredito !== undefined && { valorCredito }),
  };
}
