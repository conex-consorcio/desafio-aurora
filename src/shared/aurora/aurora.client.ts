import { Injectable, Logger } from "@nestjs/common";

export interface RegistrarLanceRequest {
  grupo: string;
  cota: string;
  assembleia: string;
}

export interface RegistrarLanceResponse {
  protocolo: string;
  vezRegistrada: number;
}

export interface CotaDetalhe {
  grupo: string;
  numero: string;
  situacao: string;
  valorCredito: number;
}

/**
 * Cliente HTTP da Aurora.
 *
 * Conhece o transporte, nao conhece negocio.
 */
@Injectable()
export class AuroraClient {
  private readonly logger = new Logger(AuroraClient.name);
  private readonly baseUrl = process.env.AURORA_BASE_URL ?? "http://localhost:4010";

  async registrarLance(
    request: RegistrarLanceRequest,
  ): Promise<RegistrarLanceResponse> {
    const resposta = await fetch(`${this.baseUrl}/lances/registrar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!resposta.ok) {
      throw new Error(`aurora:registrarLance status ${resposta.status}`);
    }

    return (await resposta.json()) as RegistrarLanceResponse;
  }

  async detalheCota(grupo: string, numero: string): Promise<CotaDetalhe> {
    const resposta = await fetch(`${this.baseUrl}/cotas/${grupo}/${numero}`);

    if (!resposta.ok) {
      throw new Error(`aurora:detalheCota status ${resposta.status}`);
    }

    return (await resposta.json()) as CotaDetalhe;
  }
}
