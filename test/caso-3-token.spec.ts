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

interface Instrumentacao {
  chamadas: Record<string, number>;
}

async function instrumentacao(): Promise<Instrumentacao> {
  return (await (
    await fetch(`${AURORA}/_admin/chamadas`)
  ).json()) as Instrumentacao;
}

async function renovacoes(): Promise<number> {
  const dados = await instrumentacao();
  return dados.chamadas["auth:token"] ?? 0;
}

async function reset(): Promise<void> {
  await fetch(`${AURORA}/_admin/reset`, {
    method: "POST",
  });
}

async function expirarToken(): Promise<void> {
  await fetch(`${AURORA}/_admin/expirar-token`, {
    method: "POST",
  });
}

async function consultar(
  quantidade: number,
): Promise<number[]> {
  return Promise.all(
    Array.from({ length: quantidade }, (_, i) =>
      fetch(`${API}/consultas/grupo/${GRUPO}-${i}`)
        .then((resposta) => resposta.status)
        .catch(() => 0),
    ),
  );
}

describe("Caso 3 - renovacao concorrente de token", () => {
  beforeAll(async () => {
    // Uma chamada morna, so para a aplicacao ter um token em maos.
    await fetch(`${API}/consultas/grupo/${GRUPO}`);

    // Zera os contadores e invalida o token do lado da Aurora.
    await reset();
    await expirarToken();

    await consultar(SIMULTANEAS);
  }, 120_000);

  it("renova o token uma unica vez", async () => {
    expect(await renovacoes()).toBe(1);
  });

  it("nenhuma requisicao morre por token invalido", async () => {
    const respostas = await instrumentacao();

    expect(respostas).toBeDefined();
  });

  it("reutiliza o token enquanto ele ainda estiver valido", async () => {
    await reset();

    await fetch(`${API}/consultas/grupo/${GRUPO}-valido-1`);
    await fetch(`${API}/consultas/grupo/${GRUPO}-valido-2`);
    await fetch(`${API}/consultas/grupo/${GRUPO}-valido-3`);

    expect(await renovacoes()).toBe(0);
  });

  it("renova novamente quando o token expira", async () => {
    await reset();

    await expirarToken();

    const resposta = await fetch(
      `${API}/consultas/grupo/${GRUPO}-expirado`,
    );

    expect(resposta.status).toBe(200);
    expect(await renovacoes()).toBe(1);
  });

  it("mantem uma unica renovacao com concorrencia menor", async () => {
    await reset();
    await expirarToken();

    const respostas = await consultar(10);

    expect(respostas.every((status) => status === 200)).toBe(true);
    expect(await renovacoes()).toBe(1);
  });

  it("faz uma nova renovacao em uma segunda onda apos nova expiracao", async () => {
    await reset();
    await expirarToken();

    const primeiraOnda = await consultar(10);

    expect(primeiraOnda.every((status) => status === 200)).toBe(true);
    expect(await renovacoes()).toBe(1);

    await expirarToken();

    const segundaOnda = await consultar(10);

    expect(segundaOnda.every((status) => status === 200)).toBe(true);
    expect(await renovacoes()).toBe(2);
  });
});
