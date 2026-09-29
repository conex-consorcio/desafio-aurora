import { describe, expect, it } from "@jest/globals";
import { ErroDoParceiro, TimeoutParceiroError } from "@shared/http/erro-do-parceiro.error";
import { LancesWorker } from "./lances.worker";

const MES = process.env.TEST_RUN_ID ?? `spec-worker-${Date.now()}`;

const COTAS = [
  { grupo: "0001", numero: "0001", situacao: "DISPONIVEL" },
  { grupo: "0001", numero: "0002", situacao: "DISPONIVEL" },
  { grupo: "0001", numero: "0003", situacao: "DISPONIVEL" },
];

class PrismaFalso {
  cotas: { grupo: string; numero: string; situacao: string }[];

  constructor(cotas: { grupo: string; numero: string; situacao: string }[]) {
    this.cotas = cotas;
  }

  cota = {
    findMany: async () => this.cotas,
  };
}

class RegistradorFalso {
  chamadas: Record<string, number> = {};
  erros: Record<string, { error: unknown; vezes: number }> = {};

  async registrar(input: { grupo: string; cota: string; assembleia: string }) {
    const chave = `${input.grupo}:${input.cota}`;
    this.chamadas[chave] = (this.chamadas[chave] ?? 0) + 1;

    const config = this.erros[chave];
    if (config && config.vezes > 0) {
      config.vezes -= 1;
      throw config.error;
    }

    return { protocolo: `PRT-${chave}`, jaRegistrado: false };
  }
}

/** Emula o subset do ioredis que o worker usa (strings + sorted sets + eval). */
class RedisFalso {
  private strings = new Map<string, string>();
  private zsets = new Map<string, Map<string, number>>();
  private sets = new Map<string, Set<string>>();

  async get(chave: string): Promise<string | null> {
    return this.strings.get(chave) ?? null;
  }

  async set(
    chave: string,
    valor: string,
    _modo?: string,
    _tempo?: string | number,
    condicao?: string,
  ): Promise<string | null> {
    if (condicao === "NX" && this.strings.has(chave)) return null;
    this.strings.set(chave, valor);
    return "OK";
  }

  async del(chave: string): Promise<number> {
    return this.strings.delete(chave) ? 1 : 0;
  }

  async exists(chave: string): Promise<number> {
    return this.strings.has(chave) || this.zsets.has(chave) || this.sets.has(chave)
      ? 1
      : 0;
  }

  async sadd(chave: string, membro: string): Promise<number> {
    const conjunto = this.sets.get(chave);
    if (conjunto) {
      const eraNuevo = !conjunto.has(membro);
      conjunto.add(membro);
      return eraNuevo ? 1 : 0;
    }
    this.sets.set(chave, new Set([membro]));
    return 1;
  }

  async sismember(chave: string, membro: string): Promise<number> {
    return this.sets.get(chave)?.has(membro) ? 1 : 0;
  }

  async zadd(chave: string, ...membros: (string | number)[]): Promise<number> {
    const conjunto = this.zset(chave);
    let adicionados = 0;
    for (let i = 0; i + 1 < membros.length; i += 2) {
      const score = Number(membros[i]);
      const membro = String(membros[i + 1]);
      if (!conjunto.has(membro)) adicionados += 1;
      conjunto.set(membro, score);
    }
    return adicionados;
  }

  async zrem(chave: string, membro: string): Promise<number> {
    const conjunto = this.zsets.get(chave);
    if (!conjunto) return 0;
    return conjunto.delete(membro) ? 1 : 0;
  }

  async zcard(chave: string): Promise<number> {
    return this.zsets.get(chave)?.size ?? 0;
  }

  private zset(chave: string): Map<string, number> {
    const atual = this.zsets.get(chave);
    if (atual) return atual;
    const novo = new Map<string, number>();
    this.zsets.set(chave, novo);
    return novo;
  }

  /** Reimplementa os scripts Lua que o worker usa. */
  async eval(
    script: string,
    _numChaves: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    if (script.includes("zpopmin")) {
      return this.reclamar(String(args[0]), String(args[1]), Number(args[2]));
    }
    if (script.includes("zrangebyscore")) {
      return this.retomarOrfanos(String(args[0]), String(args[1]), Number(args[2]));
    }
    return this.soltarLock(String(args[0]), String(args[1]));
  }

  private reclamar(fila: string, processando: string, lease: number): [string, number] | null {
    const conjunto = this.zsets.get(fila);
    if (!conjunto || conjunto.size === 0) return null;

    let melhor: string | undefined;
    let melhorScore = Infinity;
    for (const [membro, score] of conjunto) {
      if (score < melhorScore) {
        melhor = membro;
        melhorScore = score;
      }
    }

    conjunto.delete(melhor!);
    this.zset(processando).set(melhor!, lease);
    return [melhor!, melhorScore];
  }

  private retomarOrfanos(fila: string, processando: string, agora: number): number {
    const conjunto = this.zsets.get(processando);
    if (!conjunto) return 0;

    let movidos = 0;
    for (const [membro, score] of [...conjunto]) {
      if (score <= agora) {
        conjunto.delete(membro);
        this.zset(fila).set(membro, 0);
        movidos += 1;
      }
    }
    return movidos;
  }

  private soltarLock(chave: string, dono: string): number {
    if (this.strings.get(chave) === dono) {
      this.strings.delete(chave);
      return 1;
    }
    return 0;
  }
}

function worker(redis: RedisFalso, registrador: RegistradorFalso, prisma: PrismaFalso) {
  return new LancesWorker(prisma as never, redis as never, registrador as never);
}

describe("LancesWorker", () => {
  it("enfileira uma unica vez e processa cada cota uma unica vez com varios workers", async () => {
    const redis = new RedisFalso();
    const registrador = new RegistradorFalso();
    const prisma = new PrismaFalso(COTAS);

    await Promise.all([
      worker(redis, registrador, prisma).rodar(MES),
      worker(redis, registrador, prisma).rodar(MES),
    ]);

    expect(Object.keys(registrador.chamadas)).toHaveLength(COTAS.length);
    for (const vezes of Object.values(registrador.chamadas)) {
      expect(vezes).toBe(1);
    }
    expect(await redis.zcard(`lances:fila:${MES}`)).toBe(0);
    expect(await redis.zcard(`lances:processando:${MES}`)).toBe(0);
  });

  it("retoma o item orfano cujo lease expirou", async () => {
    const redis = new RedisFalso();
    const registrador = new RegistradorFalso();
    const prisma = new PrismaFalso([]);

    await redis.zadd(`lances:processando:${MES}`, Date.now() - 1_000, "0001:0009");
    await redis.set(`lances:job:${MES}:feito`, "1");

    await worker(redis, registrador, prisma).rodar(MES);

    expect(registrador.chamadas["0001:0009"]).toBe(1);
    expect(await redis.zcard(`lances:fila:${MES}`)).toBe(0);
    expect(await redis.zcard(`lances:processando:${MES}`)).toBe(0);
  });

  it("reenfileira a cota quando o parceiro falha de forma transitoria", async () => {
    const redis = new RedisFalso();
    const registrador = new RegistradorFalso();
    registrador.erros["0001:0002"] = {
      error: new TimeoutParceiroError(),
      vezes: 1,
    };
    const prisma = new PrismaFalso(COTAS);

    await worker(redis, registrador, prisma).rodar(MES);

    expect(registrador.chamadas["0001:0002"]).toBe(2);
    expect(registrador.chamadas["0001:0001"]).toBe(1);
    expect(registrador.chamadas["0001:0003"]).toBe(1);
    expect(await redis.zcard(`lances:fila:${MES}`)).toBe(0);
    expect(await redis.zcard(`lances:processando:${MES}`)).toBe(0);
  });

  it("nao reenfileira a cota quando o parceiro responde 400", async () => {
    const redis = new RedisFalso();
    const registrador = new RegistradorFalso();
    registrador.erros["0001:0002"] = {
      error: new ErroDoParceiro("400", 400),
      vezes: 1,
    };
    const prisma = new PrismaFalso(COTAS);

    await worker(redis, registrador, prisma).rodar(MES);

    expect(registrador.chamadas["0001:0002"]).toBe(1);
    expect(await redis.zcard(`lances:fila:${MES}`)).toBe(0);
    expect(await redis.zcard(`lances:processando:${MES}`)).toBe(0);
  });

  it("reenfileira a cota quando o 401 vem do thrash de token de outra instancia", async () => {
    const redis = new RedisFalso();
    const registrador = new RegistradorFalso();
    registrador.erros["0001:0002"] = {
      error: new ErroDoParceiro("401", 401),
      vezes: 1,
    };
    const prisma = new PrismaFalso(COTAS);

    await worker(redis, registrador, prisma).rodar(MES);

    expect(registrador.chamadas["0001:0002"]).toBe(2);
    expect(await redis.sismember(`lances:falhadas:${MES}`, "0001:0002")).toBe(0);
    expect(await redis.zcard(`lances:fila:${MES}`)).toBe(0);
    expect(await redis.zcard(`lances:processando:${MES}`)).toBe(0);
  });

  it("abandona em falhadas a cota que esgota as tentativas", async () => {
    const redis = new RedisFalso();
    const registrador = new RegistradorFalso();
    registrador.erros["0001:0002"] = {
      error: new TimeoutParceiroError(),
      vezes: Infinity,
    };
    const prisma = new PrismaFalso(COTAS);

    await worker(redis, registrador, prisma).rodar(MES);

    expect(registrador.chamadas["0001:0002"]).toBe(3);
    expect(await redis.sismember(`lances:falhadas:${MES}`, "0001:0002")).toBe(1);
    expect(await redis.zcard(`lances:fila:${MES}`)).toBe(0);
    expect(await redis.zcard(`lances:processando:${MES}`)).toBe(0);
  });
});