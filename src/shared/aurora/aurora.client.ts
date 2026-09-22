import { Injectable, Logger } from "@nestjs/common";
import { AuroraTokenProvider } from "./aurora-token.provider";

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

  constructor(private readonly tokens: AuroraTokenProvider) {}

  /**
   * Faz a chamada com o token atual. Se a Aurora responder 401, renova e
   * tenta uma vez mais -- o token pode ter expirado no meio do caminho.
   */
  private async comToken(
    executar: (token: string) => Promise<Response>,
  ): Promise<Response> {
    const resposta = await executar(await this.tokens.obter());
    if (resposta.status !== 401) return resposta;

    return executar(await this.tokens.renovar());
  }

  async registrarLance(
    request: RegistrarLanceRequest,
  ): Promise<RegistrarLanceResponse> {
    const resposta = await this.comToken((token) =>
      fetch(`${this.baseUrl}/lances/registrar`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      }),
    );

    if (!resposta.ok) {
      throw new Error(`aurora:registrarLance status ${resposta.status}`);
    }

    return (await resposta.json()) as RegistrarLanceResponse;
  }

  async detalheGrupo(numero: string): Promise<unknown> {
    const resposta = await this.comToken((token) =>
      fetch(`${this.baseUrl}/grupos/${numero}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    if (!resposta.ok) {
      throw new Error(`aurora:detalheGrupo status ${resposta.status}`);
    }

    return resposta.json();
  }

  async detalheCota(grupo: string, numero: string): Promise<CotaDetalhe> {
    const resposta = await this.comToken((token) =>
      fetch(`${this.baseUrl}/cotas/${grupo}/${numero}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    if (!resposta.ok) {
      throw new Error(`aurora:detalheCota status ${resposta.status}`);
    }

    return (await resposta.json()) as CotaDetalhe;
  }
}
