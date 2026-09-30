import { Injectable, Logger } from "@nestjs/common";
import { ParceiroFalhaError, paraParceiroFalha } from "@shared/http/parceiro-falha.error";
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
 * Acima do p100 observado da Aurora (900ms) com folga. Um timeout curto
 * demais, seguido de nova tentativa, faz o parceiro processar a mesma coisa
 * duas vezes.
 */
const TIMEOUT_MS = 10_000;

/**
 * Cliente HTTP da Aurora.
 *
 * Conhece o transporte, nao conhece negocio. Toda falha sai daqui como
 * ParceiroFalhaError, dizendo se a requisicao pode ter chegado la.
 */
@Injectable()
export class AuroraClient {
  private readonly logger = new Logger(AuroraClient.name);
  private readonly baseUrl = process.env.AURORA_BASE_URL ?? "http://localhost:4010";

  constructor(private readonly tokens: AuroraTokenProvider) {}

  /**
   * Faz a chamada com o token atual. Se a Aurora responder 401, renova e
   * tenta uma vez mais -- o token pode ter expirado no meio do caminho.
   *
   * Falha ao obter token acontece ANTES de qualquer envio: efeito impossivel.
   */
  private async comToken(
    operacao: string,
    executar: (token: string) => Promise<Response>,
  ): Promise<Response> {
    const token = await this.semEfeito(operacao, () => this.tokens.obter());
    const resposta = await this.enviar(operacao, () => executar(token));
    if (resposta.status !== 401) return resposta;

    const novo = await this.semEfeito(operacao, () => this.tokens.renovar(token));
    return this.enviar(operacao, () => executar(novo));
  }

  private async semEfeito<T>(operacao: string, obter: () => Promise<T>): Promise<T> {
    try {
      return await obter();
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      throw new ParceiroFalhaError(operacao, `sem token (${motivo})`, false);
    }
  }

  private async enviar(
    operacao: string,
    executar: () => Promise<Response>,
  ): Promise<Response> {
    try {
      return await executar();
    } catch (erro) {
      throw paraParceiroFalha(operacao, erro);
    }
  }

  private recusa(operacao: string, resposta: Response): ParceiroFalhaError {
    return new ParceiroFalhaError(
      operacao,
      `status ${resposta.status}`,
      false,
      resposta.status,
    );
  }

  async registrarLance(
    request: RegistrarLanceRequest,
  ): Promise<RegistrarLanceResponse> {
    const resposta = await this.comToken("registrarLance", (token) =>
      fetch(`${this.baseUrl}/lances/registrar`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );

    if (!resposta.ok) {
      throw this.recusa("registrarLance", resposta);
    }

    return (await resposta.json()) as RegistrarLanceResponse;
  }

  async detalheGrupo(numero: string): Promise<unknown> {
    const resposta = await this.comToken("detalheGrupo", (token) =>
      fetch(`${this.baseUrl}/grupos/${numero}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );

    if (!resposta.ok) {
      throw this.recusa("detalheGrupo", resposta);
    }

    return resposta.json();
  }

  async detalheCota(grupo: string, numero: string): Promise<CotaDetalhe> {
    const resposta = await this.comToken("detalheCota", (token) =>
      fetch(`${this.baseUrl}/cotas/${grupo}/${numero}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );

    if (!resposta.ok) {
      throw this.recusa("detalheCota", resposta);
    }

    return (await resposta.json()) as CotaDetalhe;
  }
}
