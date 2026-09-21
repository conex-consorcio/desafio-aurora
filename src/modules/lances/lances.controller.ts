import { Body, Controller, Post } from "@nestjs/common";
import { LancesService, type RegistrarLanceInput } from "./lances.service";

@Controller("lances")
export class LancesController {
  constructor(private readonly lances: LancesService) {}

  @Post("registrar")
  async registrar(@Body() body: RegistrarLanceInput) {
    return this.lances.registrar(body);
  }
}
