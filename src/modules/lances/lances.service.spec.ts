import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { LancesService, type RegistrarLanceInput } from "./lances.service";
import { ContractViolationError } from "@shared/http/contract-violation.error";
import type { PrismaService } from "@shared/prisma/prisma.service";
import type { AuroraClient } from "@shared/aurora/aurora.client";
import type { RedisService } from "@shared/redis/redis.service";

describe("LancesService", () => {
  let fakeDb: Map<string, { id: string; grupo: string; cota: string; assembleia: string; protocolo: string | null }>;
  let fakeRedisCache: Map<string, string>;
  let activeLocks: Map<string, string>;
  let auroraChamadas: number;

  let prismaMock: Partial<PrismaService>;
  let auroraMock: Partial<AuroraClient>;
  let redisMock: Partial<RedisService>;
  let service: LancesService;

  const INPUT_PADRAO: RegistrarLanceInput = {
    grupo: "9001",
    cota: "0042",
    assembleia: "2026-04",
  };

  beforeEach(() => {
    fakeDb = new Map();
    fakeRedisCache = new Map();
    activeLocks = new Map();
    auroraChamadas = 0;

    prismaMock = {
      lance: {
        findFirst: jest.fn(async ({ where }: { where: { grupo: string; cota: string; assembleia: string } }) => {
          const chave = `${where.grupo}:${where.cota}:${where.assembleia}`;
          return fakeDb.get(chave) ?? null;
        }),
        create: jest.fn(async ({ data }: { data: { grupo: string; cota: string; assembleia: string; protocolo: string } }) => {
          const chave = `${data.grupo}:${data.cota}:${data.assembleia}`;
          const registro = { id: "id-123", ...data };
          fakeDb.set(chave, registro);
          return registro;
        }),
      } as unknown as PrismaService["lance"],
    };

    auroraMock = {
      registrarLance: jest.fn(async (input: RegistrarLanceInput) => {
        auroraChamadas += 1;
        return {
          protocolo: `PRT-AURORA-${auroraChamadas}`,
          vezRegistrada: auroraChamadas,
        };
      }),
    };

    redisMock = {
      obter: jest.fn(async (chave: string) => fakeRedisCache.get(chave) ?? null),
      definir: jest.fn(async (chave: string, valor: string) => {
        fakeRedisCache.set(chave, valor);
        return "OK";
      }),
      existe: jest.fn(async (chave: string) => (activeLocks.has(chave) ? 1 : 0)),
      adquirirBloqueio: jest.fn(async (chave: string, _ttl: number) => {
        if (activeLocks.has(chave)) {
          return { adquirido: false, idDono: "" };
        }
        const idDono = "dono-" + Math.random();
        activeLocks.set(chave, idDono);
        return { adquirido: true, idDono };
      }),
      liberarBloqueio: jest.fn(async (chave: string, idDono: string) => {
        if (activeLocks.get(chave) === idDono) {
          activeLocks.delete(chave);
          return true;
        }
        return false;
      }),
    };

    service = new LancesService(
      prismaMock as PrismaService,
      auroraMock as AuroraClient,
      redisMock as RedisService,
    );
  });

  it("registra lance com sucesso na primeira tentativa e persiste protocolo", async () => {
    const resultado = await service.registrar(INPUT_PADRAO);

    expect(resultado.protocolo).toBe("PRT-AURORA-1");
    expect(resultado.jaRegistrado).toBe(false);
    expect(auroraChamadas).toBe(1);

    const chave = `${INPUT_PADRAO.grupo}:${INPUT_PADRAO.cota}:${INPUT_PADRAO.assembleia}`;
    expect(fakeDb.get(chave)?.protocolo).toBe("PRT-AURORA-1");
    expect(fakeRedisCache.get(`protocolo:lance:${chave}`)).toBe("PRT-AURORA-1");
  });

  it("retorna protocolo imediatamente do cache redis sem consultar banco nem parceiro", async () => {
    const cacheKey = `protocolo:lance:${INPUT_PADRAO.grupo}:${INPUT_PADRAO.cota}:${INPUT_PADRAO.assembleia}`;
    fakeRedisCache.set(cacheKey, "PRT-EM-CACHE");

    const resultado = await service.registrar(INPUT_PADRAO);

    expect(resultado.protocolo).toBe("PRT-EM-CACHE");
    expect(resultado.jaRegistrado).toBe(true);
    expect(auroraChamadas).toBe(0);
    expect(prismaMock.lance!.findFirst).not.toHaveBeenCalled();
  });

  it("retorna protocolo do banco e popula cache quando ja registrado previamente", async () => {
    const chave = `${INPUT_PADRAO.grupo}:${INPUT_PADRAO.cota}:${INPUT_PADRAO.assembleia}`;
    fakeDb.set(chave, {
      id: "id-previo",
      grupo: INPUT_PADRAO.grupo,
      cota: INPUT_PADRAO.cota,
      assembleia: INPUT_PADRAO.assembleia,
      protocolo: "PRT-DO-BANCO",
    });

    const resultado = await service.registrar(INPUT_PADRAO);

    expect(resultado.protocolo).toBe("PRT-DO-BANCO");
    expect(resultado.jaRegistrado).toBe(true);
    expect(auroraChamadas).toBe(0);
    expect(fakeRedisCache.get(`protocolo:lance:${chave}`)).toBe("PRT-DO-BANCO");
  });

  it("assegura que chamadores concorrentes aguardam o lock e compartilham o mesmo protocolo gerado", async () => {
    // Simula latencia da Aurora para permitir que chamadas concorrentes alcancem o lock
    auroraMock.registrarLance = jest.fn(async () => {
      auroraChamadas += 1;
      await new Promise((r) => setTimeout(r, 60));
      return {
        protocolo: "PRT-COMPARTILHADO",
        vezRegistrada: 1,
      };
    });

    const [res1, res2, res3] = await Promise.all([
      service.registrar(INPUT_PADRAO),
      service.registrar(INPUT_PADRAO),
      service.registrar(INPUT_PADRAO),
    ]);

    expect(auroraChamadas).toBe(1);
    expect(res1.protocolo).toBe("PRT-COMPARTILHADO");
    expect(res2.protocolo).toBe("PRT-COMPARTILHADO");
    expect(res3.protocolo).toBe("PRT-COMPARTILHADO");
  });

  it("permite que outro chamador assuma a lideranca caso o detentor do lock falhe ou expire sem registrar", async () => {
    const lockKey = `lock:lance:${INPUT_PADRAO.grupo}:${INPUT_PADRAO.cota}:${INPUT_PADRAO.assembleia}`;
    // Lock previamente adquirido por um processo fantasma que nao registrou nada
    activeLocks.set(lockKey, "dono-morto");

    // Libera o lock apos 60ms simulando a expiracao do TTL
    setTimeout(() => {
      activeLocks.delete(lockKey);
    }, 60);

    const resultado = await service.registrar(INPUT_PADRAO);

    expect(resultado.protocolo).toBe("PRT-AURORA-1");
    expect(resultado.jaRegistrado).toBe(false);
    expect(auroraChamadas).toBe(1);
  });

  it("lanca ContractViolationError quando a Aurora responde sem protocolo valido e libera o lock", async () => {
    auroraMock.registrarLance = jest.fn(async () => {
      return { protocolo: "", vezRegistrada: 1 };
    });

    await expect(service.registrar(INPUT_PADRAO)).rejects.toBeInstanceOf(
      ContractViolationError,
    );

    const lockKey = `lock:lance:${INPUT_PADRAO.grupo}:${INPUT_PADRAO.cota}:${INPUT_PADRAO.assembleia}`;
    expect(activeLocks.has(lockKey)).toBe(false);
  });
});