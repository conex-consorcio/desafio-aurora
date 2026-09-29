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

/** Aurora falsa que so responde quando o teste mandar. */
function auroraQueSegura() {
  let liberar: (r: { protocolo: string }) => void = () => undefined;
  const registrador: LanceRegistrador = {
    registrar: () => new Promise((ok) => { liberar = ok; }),
  };
  return { registrador, liberar: () => liberar({ protocolo: "PRT-tarde" }) };
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
    expect(new Set(resultados.map((r) => r.situacao === "REGISTRADO" && r.protocolo)).size).toBe(1);
  });

  it("devolve o protocolo ja registrado sem chamar o parceiro de novo", async () => {
    const aurora = auroraQueRegistra();
    const service = new LancesService(prisma, aurora.registrador);
    const input = { grupo: "9001", cota: "0043", assembleia };

    const primeiro = await service.registrar(input);
    const segundo = await service.registrar(input);

    expect(aurora.chamadas()).toBe(1);
    expect(segundo).toEqual({ ...primeiro, jaRegistrado: true });
  });

  it("responde pendente quando o dono da reserva nao conclui dentro do prazo", async () => {
    const aurora = auroraQueSegura();
    const service = new LancesService(prisma, aurora.registrador, {
      intervaloMs: 20,
      prazoMs: 200,
    });
    const input = { grupo: "9001", cota: "0044", assembleia };

    const dono = service.registrar(input);
    await new Promise((ok) => setTimeout(ok, 30));
    const concorrente = await service.registrar(input);

    expect(concorrente).toEqual({ situacao: "PENDENTE" });

    aurora.liberar();
    await expect(dono).resolves.toMatchObject({ situacao: "REGISTRADO", protocolo: "PRT-tarde" });
  });
});
