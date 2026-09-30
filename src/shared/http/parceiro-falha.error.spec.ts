import { describe, expect, it } from "@jest/globals";

import { paraParceiroFalha } from "./parceiro-falha.error";

function erroDoFetch(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

describe("paraParceiroFalha", () => {
  it("sabe que nada saiu quando a conexao foi recusada", () => {
    const falha = paraParceiroFalha("registrarLance", erroDoFetch("ECONNREFUSED"));

    expect(falha.efeitoDesconhecido).toBe(false);
  });

  it("assume que o parceiro pode ter processado quando a conexao caiu no meio", () => {
    const falha = paraParceiroFalha("registrarLance", erroDoFetch("ECONNRESET"));

    expect(falha.efeitoDesconhecido).toBe(true);
  });

  it("assume que o parceiro pode ter processado quando o tempo esgotou", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");

    expect(paraParceiroFalha("detalheCota", timeout).efeitoDesconhecido).toBe(true);
  });
});

describe("retryAfterEmMs", () => {
  it("le segundos e data HTTP, e ignora o que nao reconhece", async () => {
    const { retryAfterEmMs } = await import("./parceiro-falha.error");
    const daquiA5s = new Date(Date.now() + 5_000).toUTCString();

    expect(retryAfterEmMs("2")).toBe(2_000);
    expect(retryAfterEmMs(daquiA5s)).toBeGreaterThan(4_000);
    expect(retryAfterEmMs("logo")).toBeUndefined();
    expect(retryAfterEmMs(null)).toBeUndefined();
  });
});
