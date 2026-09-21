import { Controller, Param, Post, Query } from "@nestjs/common";
import { CotasSyncService } from "./cotas-sync.service";

@Controller("cotas-sync")
export class CotasSyncController {
  constructor(private readonly sync: CotasSyncService) {}

  @Post(":grupo")
  async sincronizar(@Param("grupo") grupo: string, @Query("total") total?: string) {
    const sincronizadas = await this.sync.sincronizarGrupo(
      grupo,
      total ? Number(total) : undefined,
    );
    return { sincronizadas };
  }
}
