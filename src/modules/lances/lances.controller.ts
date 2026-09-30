import { Body, Controller, HttpStatus, Post, Res } from "@nestjs/common";
import { LancesService, type RegistrarLanceInput } from "./lances.service";

@Controller("lances")
export class LancesController {
  constructor(private readonly lances: LancesService) {}

  @Post("registrar")
  async registrar(
    @Body() body: RegistrarLanceInput,
    @Res({ passthrough: true }) res: { status(codigo: number): unknown },
  ) {
    const resultado = await this.lances.registrar(body);

    // A operacao existe e ainda nao concluiu: e aceita, nao falhou.
    if (resultado.situacao === "PENDENTE") {
      res.status(HttpStatus.ACCEPTED);
    }

    return resultado;
  }
}
