import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import crypto from "node:crypto";
import Redis from "ioredis";
import type { IResultadoBloqueio } from "@shared/interfaces/resultado.interface";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly cliente: Redis;

  constructor() {
    const url = process.env.REDIS_URL ?? "redis://localhost:6389";
    this.cliente = new Redis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    this.cliente.on("error", (err) => {
      this.logger.error(`Erro na conexao com Redis: ${err.message}`);
    });
  }

  obterCliente(): Redis {
    return this.cliente;
  }

  async obter(chave: string): Promise<string | null> {
    return this.cliente.get(chave);
  }

  async definir(
    chave: string,
    valor: string,
    modo?: "PX" | "EX",
    duracao?: number,
  ): Promise<string | null> {
    if (modo === "EX" && duracao !== undefined) {
      return this.cliente.set(chave, valor, "EX", duracao);
    }
    if (modo === "PX" && duracao !== undefined) {
      return this.cliente.set(chave, valor, "PX", duracao);
    }
    return this.cliente.set(chave, valor);
  }

  async remover(chave: string): Promise<number> {
    return this.cliente.del(chave);
  }

  async existe(chave: string): Promise<number> {
    return this.cliente.exists(chave);
  }

  /**
   * Adquire um bloqueio distribuído granular com TTL.
   */
  async adquirirBloqueio(chave: string, ttlMs: number): Promise<IResultadoBloqueio> {
    const idDono = crypto.randomUUID();
    const resultado = await this.cliente.set(chave, idDono, "PX", ttlMs, "NX");
    return {
      adquirido: resultado === "OK",
      idDono,
    };
  }

  /**
   * Libera o bloqueio atômico via script Lua apenas se o dono for o mesmo.
   */
  async liberarBloqueio(chave: string, idDono: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const resultado = await this.cliente.eval(script, 1, chave, idDono);
    return resultado === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.cliente.quit();
  }
}