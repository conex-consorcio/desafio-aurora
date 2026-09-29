import { afterEach, describe, expect, it } from "@jest/globals";
import {
  AuroraClient,
  AuroraRequestTimeoutError,
} from "./aurora.client";
import { AuroraTokenProvider } from "./aurora-token.provider";

const TOKENS: AuroraTokenProvider = {
  obter: async () => "token-vigente",
  renovar: async () => "token-novo",
} as AuroraTokenProvider;

function clienteConTimeout(ms: number): AuroraClient {
  process.env.AURORA_TIMEOUT_MS = String(ms);
  return new AuroraClient(TOKENS);
}

function cotaValida() {
  return new Response(
    JSON.stringify({
      grupo: "0001",
      numero: "0001",
      situacao: "DISPONIVEL",
      valorCredito: 8_990_000,
    }),
    { status: 200 },
  );
}

describe("AuroraClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renova passando a renovar o token que recebiu o 401", async () => {
    const renovar = jest.fn().mockResolvedValue("token-novo");
    const tokens = {
      obter: async () => "token-velho",
      renovar,
    } as unknown as AuroraTokenProvider;

    const chamadas = jest
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(cotaValida());
    global.fetch = chamadas as unknown as typeof fetch;

    const cliente = new AuroraClient(tokens);
    const detalhe = await cliente.detalheCota("0001", "0001");

    expect(detalhe.situacao).toBe("DISPONIVEL");
    expect(renovar).toHaveBeenCalledWith("token-velho");
  });

  it("reintenta 429 respeitando Retry-After", async () => {
    process.env.AURORA_MAX_429_RETRIES = "1";
    const chamadas = jest.fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(cotaValida());
    global.fetch = chamadas as unknown as typeof fetch;

    const cliente = new AuroraClient(TOKENS);
    const detalhe = await cliente.detalheCota("0001", "0001");

    expect(detalhe.situacao).toBe("DISPONIVEL");
    expect(chamadas).toHaveBeenCalledTimes(2);
  });

  it("esgota as tentativas de 429 e falha com status", async () => {
    process.env.AURORA_MAX_429_RETRIES = "1";
    const sempre429 = jest.fn().mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
    );
    global.fetch = sempre429 as unknown as typeof fetch;

    const cliente = new AuroraClient(TOKENS);

    await expect(cliente.detalheCota("0001", "0001")).rejects.toThrow(
      /status 429/,
    );
    expect(sempre429).toHaveBeenCalledTimes(2);
  });

  it("corta a chamada que nunca responde com AuroraRequestTimeoutError", async () => {
    const cliente = clienteConTimeout(50);

    global.fetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;

    await expect(cliente.detalheCota("0001", "0001")).rejects.toBeInstanceOf(
      AuroraRequestTimeoutError,
    );
  });
});