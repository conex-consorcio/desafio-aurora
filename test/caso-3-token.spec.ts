import { beforeAll, describe, expect, it } from "@jest/globals";

/**
 * CASO 3 - a manada de renovacao de token.
 *
 * A Aurora mantem UM token valido por vez: emitir um novo invalida o anterior.
 * Quando o token expira e varias requisicoes estao em voo, cada uma percebe a
 * expiracao e renova por conta propria -- e cada renovacao mata o token que a
 * anterior acabou de obter.
 *
 * Este teste FALHA no estado atual do repositorio.
 */
const AURORA = process.env.AURORA_BASE_URL ?? "http://localhost:4010";
const API = process.env.APP_URL ?? "http://localhost:3010";

const GRUPO = "9003";
const SIMULTANEAS = 50;

async function renovacoes(): Promise<number> {
  const corpo = (await (await fetch(`${AURORA}/_admin/chamadas`)).json()) as {
    chamadas: Record<string, number>;
  };
  return corpo.chamadas["auth:token"] ?? 0;
}

let respostas: number[] = [];

describe("Caso 3 - renovacao concorrente de token", () => {
  beforeAll(async () => {
    // Uma chamada morna, so para a aplicacao ter um token em maos.
    await fetch(`${API}/consultas/grupo/${GRUPO}`);

    // Zera os contadores e invalida o token do lado da Aurora.
    await fetch(`${AURORA}/_admin/reset`, { method: "POST" });
    await fetch(`${AURORA}/_admin/expirar-token`, { method: "POST" });

    respostas = await Promise.all(
      Array.from({ length: SIMULTANEAS }, (_, i) =>
        fetch(`${API}/consultas/grupo/${GRUPO}-${i}`)
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
  }, 120_000);

  it("renova o token uma unica vez", async () => {
    expect(await renovacoes()).toBe(1);
  });

  it("nenhuma requisicao morre por token invalido", () => {
    const falhas = respostas.filter((status) => status !== 200);

    expect(falhas).toHaveLength(0);
  });
});
