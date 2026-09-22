import { Controller, Get, Param } from "@nestjs/common";
import { AuroraClient } from "@shared/aurora/aurora.client";

@Controller("consultas")
export class ConsultasController {
  constructor(private readonly aurora: AuroraClient) {}

  @Get("grupo/:numero")
  async grupo(@Param("numero") numero: string) {
    return this.aurora.detalheGrupo(numero);
  }

  @Get("cota/:grupo/:numero")
  async cota(@Param("grupo") grupo: string, @Param("numero") numero: string) {
    return this.aurora.detalheCota(grupo, numero);
  }
}
