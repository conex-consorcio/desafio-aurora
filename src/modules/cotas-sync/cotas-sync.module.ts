import { Module } from "@nestjs/common";
import { CotasSyncService, COTA_FONTE } from "./cotas-sync.service";
import { CotasSyncController } from "./cotas-sync.controller";
import { AuroraCotaFonte } from "./aurora-cota.fonte";

@Module({
  controllers: [CotasSyncController],
  providers: [
    { provide: COTA_FONTE, useClass: AuroraCotaFonte },
    CotasSyncService,
  ],
  exports: [CotasSyncService],
})
export class CotasSyncModule {}
