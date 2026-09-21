import { describe, expect, it } from "@jest/globals";

import { ParceirosService, type ParceiroFonte } from "./parceiros.service";
import { ContractViolationError } from "@shared/http/contract-violation.error";

const VALIDO = {
  codigo: "PRC-0091",
  razaoSocial: "Aurora Participacoes LTDA",
  documento: "12345678000195",
  comissaoPercentual: 3.75,
};

function servicoQueRecebe(corpo: unknown) {
  const fonte: ParceiroFonte = { async buscar() { return corpo; } };
  return new ParceirosService(fonte);
}

describe("ParceirosService", () => {
  it("traduz o percentual de comissao para basis points", async () => {
    const parceiro = await servicoQueRecebe(VALIDO).consultar();

    expect(parceiro?.comissaoBasisPoints).toBe(375);
  });

  it("omite a comissao em vez de assumir zero quando o campo nao vem", async () => {
    const { comissaoPercentual, ...semComissao } = VALIDO;

    const parceiro = await servicoQueRecebe(semComissao).consultar();

    // Ausente e ausente. Zero seria uma afirmacao que o parceiro nao fez.
    expect(parceiro?.comissaoBasisPoints).toBeUndefined();
  });

  it("nao devolve parceiro quando falta identidade", async () => {
    const parceiro = await servicoQueRecebe({ ...VALIDO, codigo: null }).consultar();

    expect(parceiro).toBeUndefined();
  });

  it("acusa violacao de contrato quando o tipo do campo muda", async () => {
    const servico = servicoQueRecebe({ ...VALIDO, comissaoPercentual: "3,75" });

    await expect(servico.consultar()).rejects.toBeInstanceOf(ContractViolationError);
  });
});
