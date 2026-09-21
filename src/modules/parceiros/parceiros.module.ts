import { Module } from "@nestjs/common";
import { ParceirosService, PARCEIRO_FONTE } from "./parceiros.service";
import { AuroraParceiroFonte } from "./aurora-parceiro.fonte";

@Module({
  providers: [
    { provide: PARCEIRO_FONTE, useClass: AuroraParceiroFonte },
    ParceirosService,
  ],
  exports: [ParceirosService],
})
export class ParceirosModule {}
