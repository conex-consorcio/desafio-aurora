import { Injectable } from "@nestjs/common";
import type { ParceiroFonte } from "./parceiros.service";

/** Adaptador HTTP da porta ParceiroFonte. Nao interpreta nada. */
@Injectable()
export class AuroraParceiroFonte implements ParceiroFonte {
  private readonly baseUrl = process.env.AURORA_BASE_URL ?? "http://localhost:4010";

  async buscar(): Promise<unknown> {
    const resposta = await fetch(`${this.baseUrl}/parceiros`);
    return resposta.json();
  }
}
