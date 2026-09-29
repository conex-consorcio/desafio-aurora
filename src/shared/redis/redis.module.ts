import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";
import { RedisService } from "./redis.service";

export const REDIS_CLIENT = "REDIS_CLIENT";

/** Infraestrutura: um cliente Redis compartilhado por toda a aplicacao. */
@Global()
@Module({
  providers: [
    RedisService,
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis(process.env.REDIS_URL ?? "redis://localhost:6389"),
    },
  ],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule {}