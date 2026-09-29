import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import { AuroraTokenProvider } from "./aurora-token.provider";

/**
 * Aurora falsa que so sabe emitir token. Conta as emissoes -- e isso que a
 * Aurora real cobra -- e devolve um token diferente a cada uma.
 */
function auroraQueEmiteTokens(opcoes: { falhaNaPrimeira?: boolean } = {}) {
  let emissoes = 0;
  const fetchFalso: typeof fetch = async () => {
    emissoes += 1;
    await new Promise((ok) => setTimeout(ok, 20));
    if (opcoes.falhaNaPrimeira && emissoes === 1) {
      return new Response("{}", { status: 503 });
    }
    return Response.json({ accessToken: `token-${emissoes}`, expiraEm: 300 });
  };
  return { fetchFalso, emissoes: () => emissoes };
}

describe("AuroraTokenProvider", () => {
  const fetchOriginal = globalThis.fetch;

  beforeEach(() => {
    process.env.AURORA_BASE_URL = "http://aurora.falsa";
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it("emite um unico token quando varias chamadas renovam ao mesmo tempo", async () => {
    const aurora = auroraQueEmiteTokens();
    globalThis.fetch = aurora.fetchFalso;
    const provider = new AuroraTokenProvider();

    const tokens = await Promise.all(
      Array.from({ length: 50 }, () => provider.renovar()),
    );

    expect(aurora.emissoes()).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it("reaproveita o token atual quando o 401 veio de um token ja substituido", async () => {
    const aurora = auroraQueEmiteTokens();
    globalThis.fetch = aurora.fetchFalso;
    const provider = new AuroraTokenProvider();

    const antigo = await provider.renovar();
    const atual = await provider.renovar(antigo);
    const reaproveitado = await provider.renovar(antigo);

    expect(reaproveitado).toBe(atual);
    expect(aurora.emissoes()).toBe(2);
  });

  it("volta a emitir depois de uma emissao que falhou", async () => {
    const aurora = auroraQueEmiteTokens({ falhaNaPrimeira: true });
    globalThis.fetch = aurora.fetchFalso;
    const provider = new AuroraTokenProvider();

    await expect(provider.renovar()).rejects.toThrow("aurora:auth status 503");
    await expect(provider.renovar()).resolves.toBe("token-2");
  });
});
