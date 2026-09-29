import { describe, expect, it } from "@jest/globals";
import { LimiteGlobal } from "./limite-global";
import { ConcurrencyInterruptedError } from "./map-with-concurrency";
import { RedisService } from "@shared/redis/redis.service";

/**
 * Fake de Redis que implemeta o MESMO comportamento que os scripts Lua do
 * semáforo justo (leases + cola FIFO + seq), para que os unit tests não
 * precisem de um Redis real. O Lua de verdade se valida no teste de
 * integração multi-instancia.
 */
class FakeRedis {
  readonly leases = new Map<string, number>();
  readonly cola = new Map<string, number>();
  readonly colaTempo = new Map<string, number>();
  seq = 0;
  status = "ready";

  async eval(
    _script: string,
    numKeys: number,
    ...keysAndArgs: Array<number | string>
  ): Promise<unknown> {
    if (numKeys === 4) {
      const [, , , , myId, agora, leaseMs, limite, colaTtl] = keysAndArgs;
      return this.tentarAdquirir(
        String(myId),
        Number(agora),
        Number(leaseMs),
        Number(limite),
        Number(colaTtl),
      );
    }

    const [token, agora, leaseMs, limite, colaTtl] = keysAndArgs.slice(3);
    return this.liberarPromovendo(
      String(token),
      Number(agora),
      Number(leaseMs),
      Number(limite),
      Number(colaTtl),
    );
  }

  private tentarAdquirir(
    myId: string,
    agora: number,
    leaseMs: number,
    limite: number,
    colaTtl: number,
  ): number {
    this.limparEsperasMortas(agora, colaTtl);
    this.limparVencidos(agora);

    if (this.leases.has(myId)) return 1;
    if (this.cola.has(myId)) return 0;

    if (this.leases.size < limite && this.cola.size === 0) {
      this.leases.set(myId, agora + leaseMs);
      return 1;
    }

    this.seq += 1;
    this.cola.set(myId, this.seq);
    this.colaTempo.set(myId, agora);
    return 0;
  }

  private liberarPromovendo(
    token: string,
    agora: number,
    leaseMs: number,
    limite: number,
    colaTtl: number,
  ): number {
    this.limparEsperasMortas(agora, colaTtl);
    this.leases.delete(token);
    this.limparVencidos(agora);

    while (this.leases.size < limite) {
      let front: string | undefined;
      let frontSeq = Number.POSITIVE_INFINITY;
      for (const [member, seq] of this.cola) {
        if (seq < frontSeq) {
          frontSeq = seq;
          front = member;
        }
      }
      if (!front) break;
      this.cola.delete(front);
      this.colaTempo.delete(front);
      this.leases.set(front, agora + leaseMs);
    }
    return 1;
  }

  private limparEsperasMortas(agora: number, colaTtl: number): void {
    for (const [member, quando] of this.colaTempo) {
      if (quando <= agora - colaTtl) {
        this.cola.delete(member);
        this.colaTempo.delete(member);
      }
    }
  }

  private limparVencidos(agora: number): void {
    for (const [member, score] of this.leases) {
      if (score <= agora) this.leases.delete(member);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limiteCon(fake: FakeRedis, env: Record<string, string>): LimiteGlobal {
  for (const chave of [
    "AURORA_LIMITE_GLOBAL",
    "AURORA_LEASE_MS",
    "AURORA_TIMEOUT_MS",
  ]) {
    delete process.env[chave];
  }
  for (const [chave, valor] of Object.entries(env)) {
    process.env[chave] = valor;
  }
  const redisService = { get: () => fake } as unknown as RedisService;
  return new LimiteGlobal(redisService);
}

describe("LimiteGlobal", () => {
  it("adquire até o limite global e bloqueia a partir de aí", async () => {
    const limite = limiteCon(new FakeRedis(), { AURORA_LIMITE_GLOBAL: "2" });

    const a = await limite.adquirir();
    const b = await limite.adquirir();

    let terceiroConseguio = false;
    const terceiro = limite.adquirir().then((token) => {
      terceiroConseguio = true;
      return token;
    });

    await sleep(60);
    expect(terceiroConseguio).toBe(false);

    await limite.liberar(b);
    await terceiro;

    expect(terceiroConseguio).toBe(true);
  });

  it("release libera o slot para o seguinte", async () => {
    const limite = limiteCon(new FakeRedis(), { AURORA_LIMITE_GLOBAL: "1" });

    const token = await limite.adquirir();
    await limite.liberar(token);

    expect(await limite.adquirir()).toBeDefined();
  });

  it("recupera leases vencidos de um pod que morreu", async () => {
    const fake = new FakeRedis();
    fake.leases.set("pod-morto", Date.now() - 1_000);

    const limite = limiteCon(fake, { AURORA_LIMITE_GLOBAL: "1" });

    expect(await limite.adquirir()).toBeDefined();
  });

  it("reparte os slots de forma justa entre instancias concorrentes", async () => {
    const fake = new FakeRedis();
    const instanciaA = limiteCon(fake, { AURORA_LIMITE_GLOBAL: "4" });
    const instanciaB = limiteCon(fake, { AURORA_LIMITE_GLOBAL: "4" });

    async function trabalhar(instancia: LimiteGlobal, quantos: number) {
      let feitos = 0;
      for (let i = 0; i < quantos; i++) {
        const token = await instancia.adquirir();
        await sleep(5);
        await instancia.liberar(token);
        feitos += 1;
      }
      return feitos;
    }

    // Cada instancia pede 12 slots; o limite conjunto é 4. As duas têm que
    // terminar — ninguén morre de fome.
    const [a, b] = await Promise.all([
      trabalhar(instanciaA, 12),
      trabalhar(instanciaB, 12),
    ]);

    expect(a).toBe(12);
    expect(b).toBe(12);
  });

  it("falha com erro claro quando o presuposto se esgota e passa o prazo", async () => {
    const limite = limiteCon(new FakeRedis(), {
      AURORA_LIMITE_GLOBAL: "1",
      AURORA_TIMEOUT_MS: "50",
    });

    await limite.adquirir();

    await expect(limite.adquirir()).rejects.toThrow(/saturado/);
  });

  it("aborta a espera durante a drenagem", async () => {
    const limite = limiteCon(new FakeRedis(), { AURORA_LIMITE_GLOBAL: "1" });
    await limite.adquirir();

    await expect(limite.adquirir(() => true)).rejects.toBeInstanceOf(
      ConcurrencyInterruptedError,
    );
  });

  it("descarta esperas mortas que ficaron na fila após un run catastrófico", async () => {
    const fake = new FakeRedis();
    // Uma espera de um pod que morreu, na cola há muito tempo.
    fake.cola.set("pod-morto", 1);
    fake.colaTempo.set("pod-morto", Date.now() - 60_000);

    const limite = limiteCon(fake, { AURORA_LIMITE_GLOBAL: "1" });

    // O morto não bloqueia: se limpa e o slot se adquire.
    expect(await limite.adquirir()).toBeDefined();
    expect(fake.cola.has("pod-morto")).toBe(false);
  });

  it("reintenta enquanto redis está conectando (race de arranque)", async () => {
    const fake = new FakeRedis();
    fake.status = "connect";

    const limite = limiteCon(fake, {
      AURORA_LIMITE_GLOBAL: "1",
      AURORA_TIMEOUT_MS: "2000",
    });

    setTimeout(() => {
      fake.status = "ready";
    }, 60);

    expect(await limite.adquirir()).toBeDefined();
  });

  it("falha ruidoso se redis não está disponível", async () => {
    const fake = new FakeRedis();
    fake.status = "end";
    const limite = limiteCon(fake, { AURORA_LIMITE_GLOBAL: "1" });

    await expect(limite.adquirir()).rejects.toThrow(/redis não disponível/);
  });
});