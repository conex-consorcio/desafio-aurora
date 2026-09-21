import { beforeAll, describe, expect, it } from "@jest/globals";

/**
 * CASO 2 - sincronizar 500 cotas sem derrubar o parceiro.
 *
 * A Aurora aguenta um numero limitado de requisicoes simultaneas. Acima dele
 * responde 429 com Retry-After. Ela tambem e lenta (200ms a 900ms por cota) e
 * tem uma rota que nunca responde.
 *
 * Este teste FALHA no estado atual do repositorio.
 */
const AURORA = process.env.AURORA_BASE_URL ?? "http://localhost:4010";
const API = process.env.APP_URL ?? "http://localhost:3010";

const GRUPO = "9002";
const TOTAL = 500;

/** Sequencial levaria ~250s. Este teto proibe a solucao sequencial. */
const TETO_MS = 60_000;

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

describe("Caso 2 - sincronizacao de grupo", () => {
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

  it("nao leva 429 do parceiro", async () => {
    const dados = await instrumentacao();

    expect(dados.recusas429).toBe(0);
  });

  it("consulta cada cota exatamente uma vez", async () => {
    const dados = await instrumentacao();
    const cotas = Object.entries(dados.chamadas).filter(([chave]) =>
      chave.startsWith(`cota:${GRUPO}:`),
    );

    expect(cotas).toHaveLength(TOTAL);
    expect(cotas.filter(([, vezes]) => vezes > 1)).toHaveLength(0);
  });

  it("nao resolve serializando tudo", () => {
    // Uma a uma dariam ~250s. Se passou daqui, nao ha paralelismo nenhum.
    expect(duracaoMs).toBeLessThan(TETO_MS);
  });
});
