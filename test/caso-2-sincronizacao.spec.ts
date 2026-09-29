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

const AURORA =
  process.env.AURORA_BASE_URL ?? "http://localhost:4010";

const API =
  process.env.APP_URL ?? "http://localhost:3010";

/** Grupo novo a cada execucao, para nao herdar estado da rodada anterior. */
const GRUPO =
  process.env.TEST_RUN_ID ?? `9002-${Date.now()}`;

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
  return (await (
    await fetch(`${AURORA}/_admin/chamadas`)
  ).json()) as Instrumentacao;
}

async function reset(): Promise<void> {
  await fetch(`${AURORA}/_admin/reset`, {
    method: "POST",
  });
}

async function sincronizar(
  grupo: string,
  total: number,
): Promise<{
  status: number;
  sincronizadas: number;
  duracaoMs: number;
}> {
  const inicio = Date.now();

  const resposta = await fetch(
    `${API}/cotas-sync/${grupo}?total=${total}`,
    {
      method: "POST",
    },
  );

  const duracaoMs = Date.now() - inicio;

  const corpo = resposta.ok
    ? ((await resposta.json()) as {
        sincronizadas: number;
      })
    : null;

  return {
    status: resposta.status,
    sincronizadas: corpo?.sincronizadas ?? -1,
    duracaoMs,
  };
}

const grupoNovo = (): string =>
  `${GRUPO}-${Math.floor(Math.random() * 1e6)}`;

let duracaoMs = 0;
let status = 0;
let sincronizadas = -1;

describe("Caso 2 - sincronizacao de grupo", () => {
  beforeAll(async () => {
    await reset();

    const inicio = Date.now();

    const resposta = await fetch(
      `${API}/cotas-sync/${GRUPO}?total=${TOTAL}`,
      {
        method: "POST",
      },
    );

    duracaoMs = Date.now() - inicio;
    status = resposta.status;

    if (resposta.ok) {
      const corpo = (await resposta.json()) as {
        sincronizadas: number;
      };

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

    const cotas = Object.entries(dados.chamadas).filter(
      ([chave]) =>
        chave.startsWith(`cota:${GRUPO}:`),
    );

    expect(cotas).toHaveLength(TOTAL);
    expect(
      cotas.filter(([, vezes]) => vezes > 1),
    ).toHaveLength(0);
  });

  it("nao resolve serializando tudo", () => {
    expect(duracaoMs).toBeLessThan(TETO_MS);
  });

  it("nao ultrapassa o limite de concorrencia da Aurora", async () => {
    const dados = await instrumentacao();

    expect(
      dados.picoConcorrencia,
    ).toBeLessThanOrEqual(dados.limite);
  });

  it("sincroniza corretamente uma quantidade menor que o pool de workers", async () => {
    await reset();

    const grupo = grupoNovo();
    const total = 20;

    const resultado = await sincronizar(grupo, total);

    expect(resultado.status).toBe(201);
    expect(resultado.sincronizadas).toBe(total);

    const dados = await instrumentacao();

    const chamadas = Object.entries(
      dados.chamadas,
    ).filter(([chave]) =>
      chave.startsWith(`cota:${grupo}:`),
    );

    expect(chamadas).toHaveLength(total);
    expect(
      chamadas.filter(([, vezes]) => vezes > 1),
    ).toHaveLength(0);
  }, 120_000);
});