import { Inject, Injectable } from "@nestjs/common";
import { ContractViolationError } from "@shared/http/contract-violation.error";
import { ehParceiroRaw } from "./aurora-parceiro.types";
import { paraParceiro, type Parceiro } from "./parceiro.view-model";

export const PARCEIRO_FONTE = "PARCEIRO_FONTE";

/** Porta. O service depende disto, nao de um cliente HTTP concreto. */
export interface ParceiroFonte {
  buscar(): Promise<unknown>;
}

@Injectable()
export class ParceirosService {
  constructor(
    @Inject(PARCEIRO_FONTE) private readonly fonte: ParceiroFonte,
  ) {}

  async consultar(): Promise<Parceiro | undefined> {
    const corpo = await this.fonte.buscar();

    if (!ehParceiroRaw(corpo)) {
      throw new ContractViolationError(
        "consultarParceiro",
        "corpo com shape inesperado",
      );
    }

    return paraParceiro(corpo);
  }
}
