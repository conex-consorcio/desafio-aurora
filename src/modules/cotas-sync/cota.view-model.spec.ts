import { describe, expect, it } from "@jest/globals";

import { ehCotaRaw } from "./aurora-cota.types";
import { paraCotaDetalhe } from "./cota.view-model";

const VALIDA = { grupo: "0001", numero: "0007", situacao: "DISPONIVEL", valorCredito: 8_990_000 };

describe("detalhe da cota na fronteira", () => {
  it("mantem o valor em centavos como o parceiro manda", () => {
    expect(paraCotaDetalhe(VALIDA)?.valorCredito).toBe(8_990_000);
  });

  it("omite o valor em vez de assumir zero quando o campo nao vem", () => {
    const { valorCredito, ...semValor } = VALIDA;

    expect(paraCotaDetalhe(semValor)?.valorCredito).toBeUndefined();
  });

  it("nao devolve cota quando falta identidade", () => {
    expect(paraCotaDetalhe({ ...VALIDA, numero: "  " })).toBeUndefined();
  });

  it("acusa violacao de contrato quando o tipo do campo muda", () => {
    expect(ehCotaRaw({ ...VALIDA, valorCredito: "8.990.000,00" })).toBe(false);
  });
});
