import { describe, expect, it } from "@jest/globals";
import { CotasSyncService } from "./cotas-sync.service";
import { LimiteGlobal } from "@shared/concurrency/limite-global";
import { ConcurrencyInterruptedError } from "@shared/concurrency/map-with-concurrency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limiteGlobalQueFunciona() {
  return {
    adquirir: jest.fn(async () => "lease"),
    liberar: jest.fn(async () => undefined),
  } as unknown as LimiteGlobal;
}

describe("CotasSyncService", () => {
  it("persiste todas as cotas consultadas de uma só vez", async () => {
    process.env.AURORA_CONCURRENCIA = "4";

    const createMany = jest.fn().mockResolvedValue({ count: 3 });
    const prisma = {
      $transaction: jest.fn(
        async (fn: (tx: unknown) => unknown) => fn({ cota: { createMany } }),
      ),
    };
    const aurora = {
      detalheCota: jest.fn(async (grupo: string, numero: string) => ({
        grupo,
        numero,
        situacao: "DISPONIVEL",
        valorCredito: 8_990_000,
      })),
    };

    const servicio = new CotasSyncService(
      prisma as never,
      aurora as never,
      limiteGlobalQueFunciona(),
    );

    const sincronizadas = await servicio.sincronizarGrupo("0001", 3);

    expect(sincronizadas).toBe(3);
    expect(aurora.detalheCota).toHaveBeenCalledTimes(3);
    expect(createMany).toHaveBeenCalledTimes(1);

    const data = createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({
      grupo: "0001",
      numero: "0001",
      situacao: "DISPONIVEL",
      valorCredito: 8_990_000,
    });
    expect(data[0].sincronizadaEm).toBeInstanceOf(Date);
  });

  it("reserva e libera um lease global por cota", async () => {
    process.env.AURORA_CONCURRENCIA = "4";

    const prisma = {
      $transaction: jest.fn(
        async (fn: (tx: unknown) => unknown) => fn({ cota: { createMany: jest.fn() } }),
      ),
    };
    const aurora = {
      detalheCota: jest.fn(async (grupo: string, numero: string) => ({
        grupo,
        numero,
        situacao: "DISPONIVEL",
        valorCredito: 1,
      })),
    };
    const limiteGlobal = limiteGlobalQueFunciona();

    const servicio = new CotasSyncService(
      prisma as never,
      aurora as never,
      limiteGlobal,
    );

    await servicio.sincronizarGrupo("0001", 3);

    expect(limiteGlobal.adquirir).toHaveBeenCalledTimes(3);
    expect(limiteGlobal.liberar).toHaveBeenCalledTimes(3);
  });

  it("falha com erro claro quando o presuposto global se esgota", async () => {
    process.env.AURORA_CONCURRENCIA = "2";

    const prisma = {
      $transaction: jest.fn(
        async (fn: (tx: unknown) => unknown) => fn({ cota: { createMany: jest.fn() } }),
      ),
    };
    const aurora = { detalheCota: jest.fn(async () => ({})) };
    const limiteGlobal = {
      adquirir: async () => {
        throw new Error("limite de concorrencia global saturado");
      },
      liberar: jest.fn(async () => undefined),
    } as unknown as LimiteGlobal;

    const servicio = new CotasSyncService(
      prisma as never,
      aurora as never,
      limiteGlobal,
    );

    await expect(servicio.sincronizarGrupo("0001", 3)).rejects.toThrow(
      /saturado/,
    );
  });

  it("no persiste nada se a sincronizacao se interrompe", async () => {
    process.env.AURORA_CONCURRENCIA = "2";

    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      $transaction: jest.fn(
        async (fn: (tx: unknown) => unknown) => fn({ cota: { createMany } }),
      ),
    };
    const emVoo: Array<() => void> = [];
    const aurora = {
      detalheCota: jest.fn(() =>
        new Promise((resolve) => {
          emVoo.push(() =>
            resolve({
              grupo: "0001",
              numero: "0001",
              situacao: "DISPONIVEL",
              valorCredito: 1,
            }),
          );
        }),
      ),
    };

    const servicio = new CotasSyncService(
      prisma as never,
      aurora as never,
      limiteGlobalQueFunciona(),
    );

    const pendiente = servicio.sincronizarGrupo("0001", 4);

    await sleep(5);
    expect(emVoo).toHaveLength(2);

    servicio.onApplicationShutdown();
    emVoo.forEach((finish) => finish());

    await expect(pendiente).rejects.toBeInstanceOf(ConcurrencyInterruptedError);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("terminar espera a sincronizacao em voo antes de devolver", async () => {
    process.env.AURORA_CONCURRENCIA = "2";

    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      $transaction: jest.fn(
        async (fn: (tx: unknown) => unknown) => fn({ cota: { createMany } }),
      ),
    };
    const emVoo: Array<() => void> = [];
    const aurora = {
      detalheCota: jest.fn(() =>
        new Promise((resolve) => {
          emVoo.push(() =>
            resolve({
              grupo: "0001",
              numero: "0001",
              situacao: "DISPONIVEL",
              valorCredito: 1,
            }),
          );
        }),
      ),
    };

    const servicio = new CotasSyncService(
      prisma as never,
      aurora as never,
      limiteGlobalQueFunciona(),
    );

    const pendiente = servicio.sincronizarGrupo("0001", 4);

    await sleep(5);
    let termino = false;
    const apagado = servicio.terminar().then(() => {
      termino = true;
    });

    await sleep(5);
    expect(termino).toBe(false);

    emVoo.forEach((finish) => finish());

    await expect(pendiente).rejects.toBeInstanceOf(ConcurrencyInterruptedError);
    await apagado;
    expect(termino).toBe(true);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("recusa uma concorrencia invalida no entorno", () => {
    process.env.AURORA_CONCURRENCIA = "0";

    expect(
      () =>
        new CotasSyncService({} as never, {} as never, {} as never),
    ).toThrow(/AURORA_CONCURRENCIA/);
  });
});