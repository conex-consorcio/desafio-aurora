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
 * A Aurora tem uma rota que nunca responde. Este erro deixa ver que foi o
 * timeout que cortou, não o parceiro devolvendo 5xx.
 */
export class AuroraRequestTimeoutError extends Error {
  constructor(context: string, timeoutMs: number) {
    super(`aurora:${context} no respondeu em ${timeoutMs}ms`);
    this.name = "AuroraRequestTimeoutError";
  }
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
  private readonly timeoutMs = Number(process.env.AURORA_TIMEOUT_MS ?? 10_000);
  private readonly max429Retries = Number(process.env.AURORA_MAX_429_RETRIES ?? 2);

  constructor(private readonly tokens: AuroraTokenProvider) {}

  /**
   * Faz a chamada com o token atual. Se a Aurora responder 401, renova e
   * tenta uma vez mais -- o token pode ter expirado no meio do caminho.
   *
   * Se responder 429 (limite de concorrencia), espera `Retry-After` e
   * reintenta, até `AURORA_MAX_429_RETRIES` vezes.
   */
  private async withToken(
    context: string,
    execute: (token: string) => Promise<Response>,
  ): Promise<Response> {
    let response = await this.withFreshToken(execute);

    for (let attempt = 0; attempt < this.max429Retries; attempt++) {
      if (response.status !== 429) return response;

      await sleep(this.retryAfterMs(response));
      this.logger.warn(`aurora:${context} recebiu 429, nova tentativa ${attempt + 1}`);
      response = await this.withFreshToken(execute);
    }

    return response;
  }

  private async withFreshToken(
    execute: (token: string) => Promise<Response>,
  ): Promise<Response> {
    const token = await this.tokens.obter();
    const response = await execute(token);
    if (response.status !== 401) return response;

    return execute(await this.tokens.renovar(token));
  }

  /**
   * Corta a request depois de `timeoutMs`. Usa AbortController para não
   * vazar o socket quando o parceiro nunca responde.
   */
  private async fetchWithTimeout(
    context: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AuroraRequestTimeoutError(context, this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private retryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get("retry-after"));
    if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
    return seconds * 1000;
  }

  async registrarLance(
    request: RegistrarLanceRequest,
  ): Promise<RegistrarLanceResponse> {
    const response = await this.withToken("registrarLance", (token) =>
      this.fetchWithTimeout("registrarLance", `${this.baseUrl}/lances/registrar`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      }),
    );

    if (!response.ok) {
      throw new Error(`aurora:registrarLance status ${response.status}`);
    }

    return (await response.json()) as RegistrarLanceResponse;
  }

  async detalheGrupo(numero: string): Promise<unknown> {
    const response = await this.withToken("detalheGrupo", (token) =>
      this.fetchWithTimeout(
        "detalheGrupo",
        `${this.baseUrl}/grupos/${numero}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );

    if (!response.ok) {
      throw new Error(`aurora:detalheGrupo status ${response.status}`);
    }

    return response.json();
  }

  async detalheCota(grupo: string, numero: string): Promise<CotaDetalhe> {
    const response = await this.withToken("detalheCota", (token) =>
      this.fetchWithTimeout(
        "detalheCota",
        `${this.baseUrl}/cotas/${grupo}/${numero}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );

    if (!response.ok) {
      throw new Error(`aurora:detalheCota status ${response.status}`);
    }

    return (await response.json()) as CotaDetalhe;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}