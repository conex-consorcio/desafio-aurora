import { beforeAll, describe, expect, it } from "@jest/globals";

/**
 * CASO 1 - o lance duplicado.
 *
 * Dia 1 do mes, 06:00, todas as instancias da aplicacao acordam juntas e
 * tentam registrar o lance da mesma cota. O parceiro cobra por lance.
 *
 * Este teste FALHA no estado atual do repositorio. E o objetivo do caso.
 *
 * Rode com pelo menos DUAS instancias apontando para o MESMO banco:
 *   ./scripts/duas-instancias.sh
 *   API_URLS="http://localhost:3010,http://localhost:3011" npm run test:caso1
 */
const AURORA = process.env.AURORA_BASE_URL ?? "http://localhost:4010";
const APIS = (process.env.API_URLS ?? "http://localhost:3010").split(",");

const GRUPO = "9001";
const COTA = "0042";
const TENTATIVAS = 8;

/**
 * Chave nova a cada execucao. Sem isso a segunda rodada encontraria o lance da
 * primeira no banco e passaria sem que nada tivesse sido corrigido.
 */
const ASSEMBLEIA = process.env.TEST_RUN_ID ?? `run-${Date.now()}`;

async function chamadasNoParceiro(chave: string): Promise<number> {
  const resposta = await fetch(`${AURORA}/_admin/chamadas`);
  const corpo = (await resposta.json()) as { chamadas: Record<string, number> };
  return corpo.chamadas[chave] ?? 0;
}

describe("Caso 1 - registro concorrente de lance", () => {
  beforeAll(async () => {
    await fetch(`${AURORA}/_admin/reset`, { method: "POST" });
  });

  it("registra o lance no parceiro uma unica vez sob concorrencia", async () => {
    const disparos = Array.from({ length: TENTATIVAS }, (_, i) => {
      const api = APIS[i % APIS.length]!;
      return fetch(`${api}/lances/registrar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grupo: GRUPO, cota: COTA, assembleia: ASSEMBLEIA }),
      }).then((r) => r.json());
    });

    await Promise.all(disparos);

    const chamadas = await chamadasNoParceiro(`lance:${GRUPO}:${COTA}:${ASSEMBLEIA}`);

    expect(chamadas).toBe(1);
  });

  it("devolve o mesmo protocolo para todos os chamadores", async () => {
    const respostas = await Promise.all(
      Array.from({ length: TENTATIVAS }, (_, i) => {
        const api = APIS[i % APIS.length]!;
        return fetch(`${api}/lances/registrar`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grupo: GRUPO,
            cota: `${COTA}-b`,
            assembleia: ASSEMBLEIA,
          }),
        }).then((r) => r.json() as Promise<{ protocolo: string }>);
      }),
    );

    const distintos = new Set(respostas.map((r) => r.protocolo));

    expect(distintos.size).toBe(1);
  });
});
