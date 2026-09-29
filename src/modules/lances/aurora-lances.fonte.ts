import { Injectable } from "@nestjs/common";
import { AuroraClient } from "@shared/aurora/aurora.client";
import { TimeoutParceiroError } from "@shared/http/erro-do-parceiro.error";
import {
  type FonteDeLances,
  type RegistrarLanceInput,
  type ResultadoLanceExterno,
} from "./lances.service";

const TIMEOUT_MS = 30_000;

/** Adaptador da porta: fala com a Aurora, nao interpreta negocio. */
@Injectable()
export class AuroraLancesFonte implements FonteDeLances {
  constructor(private readonly aurora: AuroraClient) {}

  async registrar(input: RegistrarLanceInput): Promise<ResultadoLanceExterno> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const resposta = await this.aurora.registrarLance(
        input,
        controller.signal,
      );
      return { protocolo: resposta.protocolo };
    } catch (erro) {
      if (controller.signal.aborted) throw new TimeoutParceiroError();
      throw erro;
    } finally {
      clearTimeout(timer);
    }
  }
}