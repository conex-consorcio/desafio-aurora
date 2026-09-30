import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import { ContractViolationError } from "@shared/http/contract-violation.error";
import { ParceiroFalhaError } from "@shared/http/parceiro-falha.error";
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

/** Aurora falsa que falha na primeira chamada e registra nas seguintes. */
function auroraQueFalhaNaPrimeira(efeitoDesconhecido: boolean) {
  let chamadas = 0;
  const registrador: LanceRegistrador = {
    async registrar() {
      chamadas += 1;
      if (chamadas === 1) {
        throw new ParceiroFalhaError("registrarLance", "simulada", efeitoDesconhecido);
      }
      return { protocolo: `PRT-${chamadas}` };
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

  it("libera a reserva e permite nova tentativa quando a requisicao nao chegou a sair", async () => {
    const aurora = auroraQueFalhaNaPrimeira(false);
    const service = new LancesService(prisma, aurora.registrador);
    const input = { grupo: "9001", cota: "0045", assembleia };

    await expect(service.registrar(input)).rejects.toBeInstanceOf(ParceiroFalhaError);
    const segunda = await service.registrar(input);

    expect(segunda).toMatchObject({ situacao: "REGISTRADO", jaRegistrado: false });
    expect(aurora.chamadas()).toBe(2);
  });

  it("mantem a reserva pendente e nao repete quando nao se sabe se o parceiro processou", async () => {
    const aurora = auroraQueFalhaNaPrimeira(true);
    const service = new LancesService(prisma, aurora.registrador, {
      intervaloMs: 20,
      prazoMs: 100,
    });
    const input = { grupo: "9001", cota: "0046", assembleia };

    await expect(service.registrar(input)).rejects.toBeInstanceOf(ParceiroFalhaError);
    const segunda = await service.registrar(input);

    expect(segunda).toEqual({ situacao: "PENDENTE" });
    expect(aurora.chamadas()).toBe(1);
  });

  it("mantem a reserva pendente quando o parceiro confirma com resposta fora do contrato", async () => {
    let chamadas = 0;
    const auroraSemProtocolo: LanceRegistrador = {
      async registrar() {
        chamadas += 1;
        return { vezRegistrada: 1 };
      },
    };
    const service = new LancesService(prisma, auroraSemProtocolo, { intervaloMs: 20, prazoMs: 100 });
    const input = { grupo: "9001", cota: "0047", assembleia };

    await expect(service.registrar(input)).rejects.toBeInstanceOf(ContractViolationError);
    const segunda = await service.registrar(input);

    // 2xx sem protocolo: o lance existe la, cobrado. Ninguem repete.
    expect(segunda).toEqual({ situacao: "PENDENTE" });
    expect(chamadas).toBe(1);
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
