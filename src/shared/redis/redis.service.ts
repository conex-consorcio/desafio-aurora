import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Redis } from "ioredis";

/**
 * Cliente Redis da infraestrutura.
 *
 * Infra global: o limite de concorrencia distribuido e o que coordina entre
 * instancias. Se `REDIS_URL` não chega, fallback local para desenvolvimento.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | undefined;

  onModuleInit(): void {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.client = new Redis(url, { lazyConnect: true });
    void this.client.connect().then(
      () => this.logger.log(`redis conectado em ${url}`),
      (error) => this.logger.error(`redis não conectado: ${String(error)}`),
    );
  }

  onModuleDestroy(): void {
    this.client?.quit();
  }

  get(): Redis {
    if (!this.client) {
      throw new Error("RedisService ainda não inicializado");
    }
    return this.client;
  }
}