import { Module } from "@nestjs/common";
import { CotasSyncService } from "./cotas-sync.service";
import { CotasSyncController } from "./cotas-sync.controller";

@Module({
  controllers: [CotasSyncController],
  providers: [CotasSyncService],
  exports: [CotasSyncService],
})
export class CotasSyncModule {}
