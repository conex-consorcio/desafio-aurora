import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RedisService } from "@shared/redis/redis.service";

interface TokenRaw {
  accessToken: string;
  expiraEm: number;
}

const AUTH_TIMEOUT_MS = 5_000;
const ESPERA_TOKEN_MS = 3_000;
const LOCK_MS = AUTH_TIMEOUT_MS + 1_000;

/**
 * Guarda o token de acesso da Aurora, COMPARTILHADO entre instancias.
 *
 * A Aurora mantem UM token valido por vez: emitir um novo invalida o anterior.
 * Se cada instancia guardasse o seu, invalidaríam-se mutuamente (ping-pong de
 * 401) — exatamente o que derriba uma sync com vários pods. Por isso o token
 * vive em Redis: todas as instancias leem o MESMO.
 *
 * Renovação single-flight GLOBAL: um lock (`SET NX PX`) garante que só uma
 * instancia renova por vez; as outras esperan o token novo. Emitir token não
 * é barato do lado da Aurora: uma manada de POST /auth/token é abater o
 * parceiro.
 */
@Injectable()
export class AuroraTokenProvider {
  private readonly logger = new Logger(AuroraTokenProvider.name);
  private readonly baseUrl = process.env.AURORA_BASE_URL ?? "http://localhost:4010";
  private readonly chaveToken: string;
  private readonly chaveExpira: string;
  private readonly chaveLock: string;

  constructor(private readonly redis: RedisService) {
    // `REDIS_PREFIX` (default "aurora"): ambientes que compartam Redis não se
    // contaminen.
    const prefixo = process.env.REDIS_PREFIX ?? "aurora";
    this.chaveToken = `${prefixo}:token`;
    this.chaveExpira = `${prefixo}:token:expira`;
    this.chaveLock = `${prefixo}:token:renovando`;
  }

  async obter(): Promise<string> {
    const token = await this.lerTokenValido();
    if (token) return token;
    return this.renovar();
  }

  /** Renova uma única vez entre TODAS as instancias, esperando se outra renova. */
  async renovar(anterior?: string): Promise<string> {
    for (let intento = 0; intento < 2; intento++) {
      const lock = await this.tomarLock();
      if (lock) {
        try {
          const corpo = await this.buscarToken();
          await this.guardar(corpo.accessToken, corpo.expiraEm * 1000);
          this.logger.log(`token renovado, valido por ${corpo.expiraEm}s`);
          return corpo.accessToken;
        } finally {
          await this.liberarLock(lock);
        }
      }

      // Outra instancia está renovando: espera um token NOVO — nunca o mesmo
      // que já falhou, que pode seguir "válido" na nossa cache mas já não ser
      // aceito pelo parceiro.
      const token = await this.esperarTokenNovo(anterior);
      if (token) return token;
    }

    throw new Error("aurora:auth renovação concorrente não completada a tempo");
  }

  private async lerTokenValido(): Promise<string | undefined> {
    const redis = this.redis.get();
    const [valor, expiraRaw] = await redis.mget(this.chaveToken, this.chaveExpira);

    const expira = Number(expiraRaw);
    if (valor && Number.isFinite(expira) && Date.now() < expira) {
      return valor;
    }
    return undefined;
  }

  private async tomarLock(): Promise<string | undefined> {
    const token = randomUUID();
    const ok = await this.redis
      .get()
      .set(this.chaveLock, token, "PX", String(LOCK_MS), "NX");
    return ok === "OK" ? token : undefined;
  }

  private async liberarLock(token: string): Promise<void> {
    await this.redis
      .get()
      .eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        this.chaveLock,
        token,
      );
  }

  private async esperarTokenNovo(anterior?: string): Promise<string | undefined> {
    const inicio = Date.now();
    for (;;) {
const token = await this.lerTokenValido();
      if (token && token !== anterior) return token;
      if (Date.now() - inicio >= ESPERA_TOKEN_MS) return undefined;
      await sleep(50);
    }
  }

  private async buscarToken(): Promise<TokenRaw> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

    try {
      const resposta = await fetch(`${this.baseUrl}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: process.env.AURORA_CLIENT_ID ?? "parceiro-demo",
          clientSecret:
            process.env.AURORA_CLIENT_SECRET ?? "dev-secret-nao-usar-em-producao",
          integrador: process.env.AURORA_INTEGRADOR ?? "plataforma",
        }),
        signal: controller.signal,
      });

      if (!resposta.ok) {
        throw new Error(`aurora:auth status ${resposta.status}`);
      }

      return (await resposta.json()) as TokenRaw;
    } finally {
      clearTimeout(timer);
    }
  }

  private async guardar(token: string, ttlMs: number): Promise<void> {
    await this.redis.get().mset({
      [this.chaveToken]: token,
      [this.chaveExpira]: String(Date.now() + ttlMs),
    });
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}