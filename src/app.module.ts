import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "@shared/prisma/prisma.module";
import { AuroraModule } from "@shared/aurora/aurora.module";
import { ParceirosModule } from "@modules/parceiros/parceiros.module";
import { LancesModule } from "@modules/lances/lances.module";
import { CotasSyncModule } from "@modules/cotas-sync/cotas-sync.module";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    AuroraModule,
    ParceirosModule,
    LancesModule,
    CotasSyncModule,
  ],
})
export class AppModule {}
