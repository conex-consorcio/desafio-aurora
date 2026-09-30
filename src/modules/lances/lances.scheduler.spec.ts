import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import { ParceiroFalhaError } from "@shared/http/parceiro-falha.error";
import { PrismaService } from "@shared/prisma/prisma.service";
import { LancesScheduler, assembleiaDoMes } from "./lances.scheduler";
import { LancesService, type LanceRegistrador } from "./lances.service";

/** Aurora falsa: registra tudo, menos as cotas que o teste mandar falhar. */
function auroraQueFalhaNas(cotasQueFalham: string[]) {
  const registradas: string[] = [];
  const registrador: LanceRegistrador = {
    async registrar(input) {
      if (cotasQueFalham.includes(input.cota)) {
        throw new ParceiroFalhaError("registrarLance", "simulada", false);
      }
      registradas.push(input.cota);
      return { protocolo: `PRT-${input.cota}` };
    },
  };
  return { registrador, registradas };
}

describe("LancesScheduler", () => {
  const prisma = new PrismaService();
  const grupo = `spec-${Date.now()}`;
  const assembleia = assembleiaDoMes();
  const cotas = ["0001", "0002", "0003"].map((numero) => ({
    grupo,
    numero,
    situacao: "DISPONIVEL",
  }));

  /** So a leitura das cotas e falsa; os lances vao para o banco real. */
  function schedulerCom(registrador: LanceRegistrador): LancesScheduler {
    const leituraDeCotas = { cota: { findMany: async () => cotas } } as unknown as PrismaService;
    return new LancesScheduler(leituraDeCotas, new LancesService(prisma, registrador, {
      intervaloMs: 20,
      prazoMs: 5_000,
    }));
  }

  beforeAll(() => prisma.$connect());

  afterAll(async () => {
    await prisma.lance.deleteMany({ where: { grupo } });
    await prisma.$disconnect();
  });

  it("continua nas cotas seguintes quando uma cota falha", async () => {
    const aurora = auroraQueFalhaNas(["0001"]);

    await schedulerCom(aurora.registrador).registrarLancesDoMes();

    expect(aurora.registradas).toEqual(["0002", "0003"]);
  });

  it("no desligamento termina a cota em maos e nao reserva outra", async () => {
    const registradas: string[] = [];
    const auroraLenta: LanceRegistrador = {
      async registrar(input) {
        await new Promise((ok) => setTimeout(ok, 60));
        registradas.push(input.cota);
        return { protocolo: `PRT-${input.cota}` };
      },
    };
    await prisma.lance.deleteMany({ where: { grupo } });
    const scheduler = schedulerCom(auroraLenta);

    const execucao = scheduler.registrarLancesDoMes();
    await new Promise((ok) => setTimeout(ok, 20));
    await scheduler.beforeApplicationShutdown("SIGTERM");
    await execucao;

    expect(registradas).toEqual(["0001"]);
    expect(await prisma.lance.count({ where: { grupo } })).toBe(1);
    await prisma.lance.deleteMany({ where: { grupo } });
  });

  it("nao espera a reserva de outra instancia nem a repete", async () => {
    const aurora = auroraQueFalhaNas([]);
    // Outra instancia reservou a 0001 e ainda nao concluiu.
    await prisma.lance.create({ data: { grupo, cota: "0001", assembleia } });
    const inicio = Date.now();

    await schedulerCom(aurora.registrador).registrarLancesDoMes();

    expect(aurora.registradas).not.toContain("0001");
    expect(Date.now() - inicio).toBeLessThan(1_000);
  });
});
