import { Module } from "@nestjs/common";
import { CotasSyncService } from "./cotas-sync.service";
import { CotasSyncController } from "./cotas-sync.controller";
import { LimiteGlobal } from "@shared/concurrency/limite-global";

@Module({
  controllers: [CotasSyncController],
  providers: [CotasSyncService, LimiteGlobal],
  exports: [CotasSyncService],
})
export class CotasSyncModule {}