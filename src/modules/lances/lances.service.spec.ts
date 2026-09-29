import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import { PrismaService } from "@shared/prisma/prisma.service";
import { LancesService, type LanceRegistrador } from "./lances.service";

/**
 * Aurora falsa que registra lances. Conta as chamadas -- e isso que a Aurora
 * real cobra -- e demora um pouco, como a real, para a corrida ter janela.
 */
function auroraQueRegistra(atrasoMs = 50) {
  let chamadas = 0;
  const registrador: LanceRegistrador = {
    async registrar() {
      chamadas += 1;
      const vez = chamadas;
      await new Promise((ok) => setTimeout(ok, atrasoMs));
      return { protocolo: `PRT-${vez}` };
    },
  };
  return { registrador, chamadas: () => chamadas };
}

describe("LancesService", () => {
  const prisma = new PrismaService();
  /** Chave nova a cada execucao, para nao herdar lances de rodadas anteriores. */
  const assembleia = `spec-${Date.now()}`;

  beforeAll(() => prisma.$connect());

  afterAll(async () => {
    await prisma.lance.deleteMany({ where: { assembleia } });
    await prisma.$disconnect();
  });

  it("registra no parceiro uma unica vez quando varias chamadas disputam a mesma chave", async () => {
    const aurora = auroraQueRegistra();
    const service = new LancesService(prisma, aurora.registrador);
    const input = { grupo: "9001", cota: "0042", assembleia };

    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => service.registrar(input)),
    );

    expect(aurora.chamadas()).toBe(1);
    expect(new Set(resultados.map((r) => r.protocolo)).size).toBe(1);
  });
});
