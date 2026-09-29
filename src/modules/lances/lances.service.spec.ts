import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { PrismaService } from "@shared/prisma/prisma.service";
import {
  LancesService,
  type FonteDeLances,
  type RegistrarLanceInput,
} from "./lances.service";

const ASSEMBLEIA = process.env.TEST_RUN_ID ?? `spec-lances-${Date.now()}`;

/** Emula o subset do ioredis que o LancesService usa. */
class RedisFalso {
  private mapa = new Map<string, string>();

  async get(chave: string): Promise<string | null> {
    return this.mapa.get(chave) ?? null;
  }

  async set(
    chave: string,
    valor: string,
    _modo?: string,
    _tempo?: string | number,
    condicao?: string,
  ): Promise<string | null> {
    if (condicao === "NX" && this.mapa.has(chave)) return null;
    this.mapa.set(chave, valor);
    return "OK";
  }

  async del(chave: string): Promise<number> {
    return this.mapa.delete(chave) ? 1 : 0;
  }

  /** Compare-and-del, o unico script que o service usa. */
  async eval(
    _script: string,
    _numChaves: number,
    chave: string,
    dono: string,
  ): Promise<number> {
    if (this.mapa.get(chave) === dono) {
      this.mapa.delete(chave);
      return 1;
    }
    return 0;
  }
}

class FonteFalsa implements FonteDeLances {
  chamadas = 0;

  async registrar(): Promise<{ protocolo: string }> {
    this.chamadas += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { protocolo: `PRT-${this.chamadas}` };
  }
}

function instancia(prisma: PrismaService, redis: RedisFalso, fonte: FonteFalsa) {
  return new LancesService(prisma, redis as never, fonte);
}

describe("LancesService", () => {
  const prisma = new PrismaService();
  let redis: RedisFalso;
  let fonte: FonteFalsa;
  let servicoA: LancesService;
  let servicoB: LancesService;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    redis = new RedisFalso();
    fonte = new FonteFalsa();
    servicoA = instancia(prisma, redis, fonte);
    servicoB = instancia(prisma, redis, fonte);
  });

  afterEach(async () => {
    await prisma.lance.deleteMany({ where: { assembleia: ASSEMBLEIA } });
  });

  it("chama o parceiro uma unica vez quando duas instancias concorrem pela mesma cota", async () => {
    const input: RegistrarLanceInput = {
      grupo: "9001",
      cota: "0001",
      assembleia: ASSEMBLEIA,
    };

    const resultados = await Promise.all([
      servicoA.registrar(input),
      servicoB.registrar(input),
    ]);

    expect(fonte.chamadas).toBe(1);
    expect(resultados[0].protocolo).toBe(resultados[1].protocolo);
    expect(resultados.filter((r) => r.jaRegistrado)).toHaveLength(1);
  });

  it("coalesce requisicoes concorrentes da mesma instancia em uma so chamada", async () => {
    const input: RegistrarLanceInput = {
      grupo: "9001",
      cota: "0002",
      assembleia: ASSEMBLEIA,
    };

    const resultados = await Promise.all([
      servicoA.registrar(input),
      servicoA.registrar(input),
      servicoA.registrar(input),
    ]);

    expect(fonte.chamadas).toBe(1);
    expect(new Set(resultados.map((r) => r.protocolo)).size).toBe(1);
  });

  it("devolve o protocolo do vencedor ao chamador que chega depois", async () => {
    const input: RegistrarLanceInput = {
      grupo: "9001",
      cota: "0003",
      assembleia: ASSEMBLEIA,
    };

    const primeiro = await servicoA.registrar(input);
    const depois = await servicoB.registrar(input);

    expect(depois.protocolo).toBe(primeiro.protocolo);
    expect(depois.jaRegistrado).toBe(true);
    expect(fonte.chamadas).toBe(1);
  });

  it("nao chama o parceiro de novo quando o vencedor morreu depois de gravar no banco", async () => {
    const input: RegistrarLanceInput = {
      grupo: "9001",
      cota: "0004",
      assembleia: ASSEMBLEIA,
    };

    await prisma.lance.create({
      data: {
        grupo: input.grupo,
        cota: input.cota,
        assembleia: input.assembleia,
        protocolo: "PRT-orfao",
      },
    });

    const resultado = await servicoA.registrar(input);

    expect(fonte.chamadas).toBe(0);
    expect(resultado.protocolo).toBe("PRT-orfao");
    expect(resultado.jaRegistrado).toBe(true);
  });

  it("espera a um vencedor lento mas vivo (finishing) em vez de tomar posse", async () => {
    const input: RegistrarLanceInput = {
      grupo: "9001",
      cota: "0005",
      assembleia: ASSEMBLEIA,
    };

    await redis.set(`lance:lock:${input.grupo}:${input.cota}:${input.assembleia}`, "outro-dono");
    await redis.set(`lance:finishing:${input.grupo}:${input.cota}:${input.assembleia}`, "outro-dono");

    const publicar = setTimeout(async () => {
      await redis.set(`lance:resultado:${input.grupo}:${input.cota}:${input.assembleia}`, "PRT-lento", "EX", 300);
    }, 150);

    const resultado = await servicoA.registrar(input);
    clearTimeout(publicar);

    expect(fonte.chamadas).toBe(0);
    expect(resultado.protocolo).toBe("PRT-lento");
    expect(resultado.jaRegistrado).toBe(true);
  });

  it("reintenta o INSERT quando o banco falha de forma transitoria", async () => {
    const prismaFalho = new PrismaConFalhaTransitoria();
    const servico = new LancesService(prismaFalho as never, redis as never, fonte);
    const input: RegistrarLanceInput = {
      grupo: "9001",
      cota: "0006",
      assembleia: ASSEMBLEIA,
    };

    const resultado = await servico.registrar(input);

    expect(fonte.chamadas).toBe(1);
    expect(resultado.protocolo).toBeDefined();
    expect(prismaFalho.createCalls).toBe(2);
  });
});

class PrismaConFalhaTransitoria {
  createCalls = 0;

  lance = {
    create: async () => {
      this.createCalls += 1;
      if (this.createCalls === 1) throw new Error("conexao perdida");
      return { id: "gravado" };
    },
    findFirst: async () => null,
  };
}