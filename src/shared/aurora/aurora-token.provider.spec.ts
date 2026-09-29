import { afterEach, describe, expect, it } from "@jest/globals";
import { AuroraTokenProvider } from "./aurora-token.provider";
import { RedisService } from "@shared/redis/redis.service";

function tokenResponse(accessToken: string, expiraEm = 300): Response {
  return new Response(JSON.stringify({ accessToken, expiraEm }), { status: 200 });
}

/**
 * Fake de Redis: guarda valores e implementa SET NX, mget e o script de
 * liberação do lock (só remove se ainda é o nosso). Comum a todas as
 * "instancias" de um teste, como o Redis real.
 */
class FakeRedis {
  readonly store = new Map<string, string>();
  status = "ready";

  async mget(...chaves: string[]): Promise<Array<string | undefined>> {
    return chaves.map((chave) => this.store.get(chave));
  }

  async set(
    chave: string,
    valor: string,
    ...argumentos: Array<string>
  ): Promise<string | null> {
    // Forma variádica do ioredis: set(chave, valor, "PX", ms, "NX").
    const conNX = argumentos.includes("NX");
    if (conNX && this.store.has(chave)) return null;
    this.store.set(chave, valor);
    return "OK";
  }

  async eval(
    _script: string,
    _numKeys: number,
    chave: string,
    token: string,
  ): Promise<number> {
    if (this.store.get(chave) === token) {
      this.store.delete(chave);
      return 1;
    }
    return 0;
  }

  async mset(objeto: Record<string, string>): Promise<string> {
    for (const [chave, valor] of Object.entries(objeto)) {
      this.store.set(chave, valor);
    }
    return "OK";
  }
}

function providerSobre(fakeRedis: FakeRedis): AuroraTokenProvider {
  const redisService = { get: () => fakeRedis } as unknown as RedisService;
  return new AuroraTokenProvider(redisService);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AuroraTokenProvider", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renova uma única vez entre instancias concorrentes", async () => {
    const fetchMock = jest.fn().mockResolvedValue(tokenResponse("tok-1"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const redisCompartido = new FakeRedis();
    const instanciaA = providerSobre(redisCompartido);
    const instanciaB = providerSobre(redisCompartido);

    const tokens = await Promise.all([
      instanciaA.renovar(),
      instanciaB.renovar(),
      instanciaA.renovar(),
    ]);

    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("obter devolve o token compartilhado em cache enquanto é valido", async () => {
    const fetchMock = jest.fn().mockResolvedValue(tokenResponse("tok-1"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const redisCompartido = new FakeRedis();
    const instanciaA = providerSobre(redisCompartido);
    const instanciaB = providerSobre(redisCompartido);

    await instanciaA.renovar();

    expect(await instanciaB.obter()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renova de novo quando o token guardado expira", async () => {
    const fetchMock = jest
      .fn()
      .mockImplementation(() => tokenResponse("tok-1", 0));
    global.fetch = fetchMock as unknown as typeof fetch;

    const redisCompartido = new FakeRedis();
    const instancia = providerSobre(redisCompartido);

    await instancia.obter();
    await instancia.obter();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("espera um token NOVO, não o mesmo que já falhou", async () => {
    const fetchMock = jest.fn().mockResolvedValue(tokenResponse("tok-novo"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const redisCompartido = new FakeRedis();
    // O token "velho" segue "válido" na cache, mas já não é aceito pelo
    // parceiro (expirou do lado deles).
    redisCompartido.store.set("aurora:token", "velho");
    redisCompartido.store.set("aurora:token:expira", String(Date.now() + 60_000));
    // Outra instancia está renovando (lock ocupado).
    redisCompartido.store.set("aurora:token:renovando", "outra-instancia");

    const instancia = providerSobre(redisCompartido);

    let resolvido: string | undefined;
    const renovando = instancia.renovar("velho").then((token) => {
      resolvido = token;
    });

    await sleep(120);
    expect(resolvido).toBeUndefined();

    // A outra instancia termina: escreve o token novo.
    redisCompartido.store.set("aurora:token", "tok-novo");
    redisCompartido.store.set("aurora:token:expira", String(Date.now() + 300_000));

    await renovando;
    expect(resolvido).toBe("tok-novo");
  });

  it("propaga o erro de auth e libera o lock", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(tokenResponse("tok-1"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const redisCompartido = new FakeRedis();
    const instancia = providerSobre(redisCompartido);

    await expect(instancia.renovar()).rejects.toThrow(/status 500/);
    // O lock se liberou: a seguinte renovação tenta de novo.
    expect(await instancia.renovar()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});