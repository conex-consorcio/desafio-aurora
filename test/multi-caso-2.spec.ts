import { beforeAll, describe, expect, it } from "@jest/globals";

/**
 * CASO 2 - MULTI: duas instancias sincronizando ao MESMO tempo.
 *
 * Cada instancia tem o seu semáforo local (16). Sem um limite distribuido,
 * duas juntas poderiam superar o limite do parceiro (20) e cairíam 429. Este
 * teste verifica que o AGREGADO respeita o limite:
 *
 *   ./scripts/duas-instancias.sh
 *   API_URLS="http://localhost:3010,http://localhost:3011" npm run test:caso2-multi
 */
const AURORA = process.env.AURORA_BASE_URL ?? "http://localhost:4010";
const APIS = (process.env.API_URLS ?? "http://localhost:3010").split(",");

const GRUPO = `9002-m-${Date.now()}`;
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

let sincronizadas: number[] = [];

describe("Caso 2 (multi) - agregado sob o limite do parceiro", () => {
  beforeAll(async () => {
    await fetch(`${AURORA}/_admin/reset`, { method: "POST" });

    const respostas = await Promise.all(
      APIS.map((api) =>
        fetch(`${api}/cotas-sync/${GRUPO}?total=${TOTAL}`, { method: "POST" })
          .then(async (r) => ({
            status: r.status,
            sincronizadas: r.ok
              ? ((await r.json()) as { sincronizadas: number }).sincronizadas
              : -1,
          })),
      ),
    );

    sincronizadas = respostas.map((r) => r.sincronizadas);
  }, 300_000);

  it("todas as instancias sincronizam as 500 cotas", () => {
    expect(sincronizadas).toHaveLength(APIS.length);
    expect(sincronizadas.every((n) => n === TOTAL)).toBe(true);
  });

  it("o agregado nunca chega ao limite do parceiro", async () => {
    const dados = await instrumentacao();

    // Pico de requests SIMULTANEAS visto pelo parceiro, vindas de todas as
    // instancias juntas. O limite distribuido tem que mantê-lo por debaixo
    // do limite do parceiro.
    expect(dados.picoConcorrencia).toBeLessThan(dados.limite);
  });

  it("nenhuna instancia recebe 429", async () => {
    const dados = await instrumentacao();

    expect(dados.recusas429).toBe(0);
  });
});