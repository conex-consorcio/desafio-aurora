import { Injectable, Logger } from "@nestjs/common";
import { ErroDoParceiro } from "@shared/http/erro-do-parceiro.error";
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
   */
  private async comToken(
    executar: (token: string) => Promise<Response>,
  ): Promise<Response> {
    const token = await this.tokens.obter();
    const resposta = await executar(token);
    if (resposta.status !== 401) return resposta;

    return executar(await this.tokens.renovar(token));
  }

  /**
   * Além da renovación por 401, se a Aurora responder 429 (limite de
   * concorrencia), espera `Retry-After` e reintenta, até
   * `AURORA_MAX_429_RETRIES` vezes.
   */
  private async comTokenCom429(
    context: string,
    executar: (token: string) => Promise<Response>,
  ): Promise<Response> {
    let resposta = await this.comToken(executar);

    for (let tentativa = 0; tentativa < this.max429Retries; tentativa++) {
      if (resposta.status !== 429) return resposta;

      await sleep(this.retryAfterMs(resposta));
      this.logger.warn(
        `aurora:${context} recebiu 429, nova tentativa ${tentativa + 1}`,
      );
      resposta = await this.comToken(executar);
    }

    return resposta;
  }

  /**
   * Corta a request depois de `timeoutMs`. Usa AbortController para não
   * vazar o socket quando o parceiro nunca responde. Se quem chama passou
   * um `signal`, os dois se combinan: un abort externo corta também.
   */
  private async fetchComTimeout(
    context: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const sinalExterno = init.signal;
    if (sinalExterno?.aborted) {
      controller.abort();
    } else {
      sinalExterno?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !sinalExterno?.aborted) {
        throw new AuroraRequestTimeoutError(context, this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private retryAfterMs(resposta: Response): number {
    const seconds = Number(resposta.headers.get("retry-after"));
    if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
    return seconds * 1000;
  }

  async registrarLance(
    request: RegistrarLanceRequest,
    sinal?: AbortSignal,
  ): Promise<RegistrarLanceResponse> {
    const resposta = await this.comTokenCom429("registrarLance", (token) =>
      this.fetchComTimeout(
        "registrarLance",
        `${this.baseUrl}/lances/registrar`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
          signal: sinal,
        },
      ),
    );

    if (!resposta.ok) {
      throw new ErroDoParceiro(
        `aurora:registrarLance status ${resposta.status}`,
        resposta.status,
      );
    }

    return (await resposta.json()) as RegistrarLanceResponse;
  }

  async detalheGrupo(numero: string): Promise<unknown> {
    const resposta = await this.comTokenCom429("detalheGrupo", (token) =>
      this.fetchComTimeout("detalheGrupo", `${this.baseUrl}/grupos/${numero}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    if (!resposta.ok) {
      throw new ErroDoParceiro(
        `aurora:detalheGrupo status ${resposta.status}`,
        resposta.status,
      );
    }

    return resposta.json();
  }

  async detalheCota(grupo: string, numero: string): Promise<CotaDetalhe> {
    const resposta = await this.comTokenCom429("detalheCota", (token) =>
      this.fetchComTimeout("detalheCota", `${this.baseUrl}/cotas/${grupo}/${numero}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    if (!resposta.ok) {
      throw new ErroDoParceiro(
        `aurora:detalheCota status ${resposta.status}`,
        resposta.status,
      );
    }

    return (await resposta.json()) as CotaDetalhe;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}