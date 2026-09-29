import { Module } from "@nestjs/common";
import {
  FONTE_LANCES,
  LancesService,
} from "./lances.service";
import { LancesController } from "./lances.controller";
import { LancesScheduler } from "./lances.scheduler";
import { LancesWorker } from "./lances.worker";
import { AuroraLancesFonte } from "./aurora-lances.fonte";

@Module({
  controllers: [LancesController],
  providers: [
    { provide: FONTE_LANCES, useClass: AuroraLancesFonte },
    LancesService,
    LancesWorker,
    LancesScheduler,
  ],
  exports: [LancesService],
})
export class LancesModule {}