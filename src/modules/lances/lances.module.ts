import { Module } from "@nestjs/common";
import { LancesService, LANCE_REGISTRADOR } from "./lances.service";
import { LancesController } from "./lances.controller";
import { LancesScheduler } from "./lances.scheduler";
import { AuroraLanceRegistrador } from "./aurora-lance.registrador";

@Module({
  controllers: [LancesController],
  providers: [
    { provide: LANCE_REGISTRADOR, useClass: AuroraLanceRegistrador },
    LancesService,
    LancesScheduler,
  ],
  exports: [LancesService],
})
export class LancesModule {}
