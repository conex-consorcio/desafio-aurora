import { beforeAll, describe, expect, it } from "@jest/globals";

/**
 * CASO 2 - EXTRA: a sincronizacao respeita o limite do parceiro.
 *
 * O teste que vem no repositorio verifica que sincroniza 500, sem 429 e
 * consultando cada cota uma vez. Este verifica o POR QUE nao caen os 429:
 * o pico de concorrencia contra o parceiro fica sempre por debaixo do seu
 * limite.
 */
const AURORA = process.env.AURORA_BASE_URL ?? "http://localhost:4010";
const API = process.env.APP_URL ?? "http://localhost:3010";

const GRUPO = `9002-x-${Date.now()}`;
const TOTAL = 500;

interface Instrumentacao {
  chamadas: Record<string, number>;
  picoConcorrencia: number;
  picoTentativas: number;
  recusas429: number;
  limite: number;
}

async function instrumentacao(): Promise<Instrumentacao> {
  return (await (await fetch(`${AURORA}/_admin/chamadas`)).json()) as Instrumentacao;
}

let duracaoMs = 0;
let status = 0;
let sincronizadas = -1;

describe("Caso 2 (extra) - limite de concorrencia do parceiro", () => {
  beforeAll(async () => {
    await fetch(`${AURORA}/_admin/reset`, { method: "POST" });

    const inicio = Date.now();
    const resposta = await fetch(`${API}/cotas-sync/${GRUPO}?total=${TOTAL}`, {
      method: "POST",
    });
    duracaoMs = Date.now() - inicio;
    status = resposta.status;

    if (resposta.ok) {
      const corpo = (await resposta.json()) as { sincronizadas: number };
      sincronizadas = corpo.sincronizadas;
    }
  }, 300_000);

  it("sincroniza as 500 cotas", () => {
    expect(status).toBe(201);
    expect(sincronizadas).toBe(TOTAL);
  });

  it("nunca chega ao limite de concorrencia do parceiro", async () => {
    const dados = await instrumentacao();

    // O pico real (requisicoes atendidas em paralelo) tem que ficar por
    // debaixo do limite do parceiro, não na borda.
    expect(dados.picoConcorrencia).toBeLessThan(dados.limite);
  });

  it("tampouco tenta mas requisicoes simultaneas do que o parceiro aguanta", async () => {
    const dados = await instrumentacao();

    expect(dados.picoTentativas).toBeLessThanOrEqual(dados.limite);
  });

  it("no recebe 429 em nenhum momento", async () => {
    const dados = await instrumentacao();

    expect(dados.recusas429).toBe(0);
  });
});