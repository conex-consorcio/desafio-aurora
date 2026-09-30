import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

import { ParceiroFalhaError } from "@shared/http/parceiro-falha.error";
import { PrismaService } from "@shared/prisma/prisma.service";
import { CotasSyncService, type CotaFonte } from "./cotas-sync.service";

interface RoteiroDaAurora {
  /** Acima disto a Aurora falsa responde 429, como a real. */
  limite: number;
  atrasoMs?: number;
  /** Cotas que levam 429 na primeira tentativa. */
  recusaNaPrimeira?: string[];
  /** Cotas cuja primeira tentativa morre sem resposta (timeout). */
  somemNaPrimeira?: string[];
}

/**
 * Aurora falsa para detalhe de cota. Conta so as consultas que ela
 * PROCESSOU (a real tambem: 429 nao entra na conta), mede o pico de
 * simultaneas e segue um roteiro de recusas e sumicos.
 */
function auroraDeCotas(roteiro: RoteiroDaAurora) {
  const processadas = new Map<string, number>();
  const tentativas = new Map<string, number>();
  let emVoo = 0;
  let pico = 0;

  const fonte: CotaFonte = {
    async buscar(grupo, numero) {
      const vez = (tentativas.get(numero) ?? 0) + 1;
      tentativas.set(numero, vez);

      if (emVoo >= roteiro.limite) {
        throw new ParceiroFalhaError("detalheCota", "status 429", false, 429, 10);
      }
      if (vez === 1 && roteiro.recusaNaPrimeira?.includes(numero)) {
        throw new ParceiroFalhaError("detalheCota", "status 429", false, 429, 30);
      }

      emVoo += 1;
      pico = Math.max(pico, emVoo);
      try {
        await new Promise((ok) => setTimeout(ok, roteiro.atrasoMs ?? 5));
        if (vez === 1 && roteiro.somemNaPrimeira?.includes(numero)) {
          throw new ParceiroFalhaError("detalheCota", "sem resposta", true);
        }
        processadas.set(numero, (processadas.get(numero) ?? 0) + 1);
        return { grupo, numero, situacao: "DISPONIVEL", valorCredito: 8_990_000 };
      } finally {
        emVoo -= 1;
      }
    },
  };

  return {
    fonte,
    pico: () => pico,
    processadas: () => processadas,
    processadaMaisDeUmaVez: () => [...processadas.entries()].filter(([, n]) => n > 1),
  };
}

describe("CotasSyncService", () => {
  const prisma = new PrismaService();
  const grupos: string[] = [];
  const TOTAL = 60;

  function grupoNovo(): string {
    const grupo = `spec-${Date.now()}-${grupos.length}`;
    grupos.push(grupo);
    return grupo;
  }

  beforeAll(() => prisma.$connect());

  afterAll(async () => {
    await prisma.cota.deleteMany({ where: { grupo: { in: grupos } } });
    await prisma.$disconnect();
  });

  it("consulta cada cota uma unica vez sem passar do limite do parceiro", async () => {
    const aurora = auroraDeCotas({ limite: 5 });
    const service = new CotasSyncService(prisma, aurora.fonte, { limite: 5 });

    const resultado = await service.sincronizarGrupo(grupoNovo(), TOTAL);

    expect(resultado).toEqual({ sincronizadas: TOTAL });
    expect(aurora.pico()).toBeLessThanOrEqual(5);
    expect(aurora.processadas().size).toBe(TOTAL);
    expect(aurora.processadaMaisDeUmaVez()).toEqual([]);
  });

  it("espera o Retry-After e repete quando o parceiro recusa por limite", async () => {
    const aurora = auroraDeCotas({ limite: 5, recusaNaPrimeira: ["0003", "0017"] });
    const service = new CotasSyncService(prisma, aurora.fonte, { limite: 5 });

    const resultado = await service.sincronizarGrupo(grupoNovo(), TOTAL);

    expect(resultado).toEqual({ sincronizadas: TOTAL });
    expect(aurora.processadaMaisDeUmaVez()).toEqual([]);
  });

  it("nao repete a consulta quando nao se sabe se o parceiro processou", async () => {
    const aurora = auroraDeCotas({ limite: 5, somemNaPrimeira: ["0009"] });
    const service = new CotasSyncService(prisma, aurora.fonte, { limite: 5 });

    const resultado = await service.sincronizarGrupo(grupoNovo(), TOTAL);

    expect(resultado).toEqual({ sincronizadas: TOTAL - 1, falhas: ["0009"] });
    expect(aurora.processadas().has("0009")).toBe(false);
  });

  it("grava cada cota assim que chega e nao duplica ao rodar de novo", async () => {
    const grupo = grupoNovo();
    const aurora = auroraDeCotas({ limite: 5, somemNaPrimeira: ["0009"] });
    const service = new CotasSyncService(prisma, aurora.fonte, { limite: 5 });

    await service.sincronizarGrupo(grupo, TOTAL);
    expect(await prisma.cota.count({ where: { grupo } })).toBe(TOTAL - 1);

    const segunda = await service.sincronizarGrupo(grupo, TOTAL);
    expect(segunda).toEqual({ sincronizadas: TOTAL });
    expect(await prisma.cota.count({ where: { grupo } })).toBe(TOTAL);
  });
});
