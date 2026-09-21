import { Module } from "@nestjs/common";
import { LancesService } from "./lances.service";
import { LancesController } from "./lances.controller";
import { LancesScheduler } from "./lances.scheduler";

@Module({
  controllers: [LancesController],
  providers: [LancesService, LancesScheduler],
  exports: [LancesService],
})
export class LancesModule {}
