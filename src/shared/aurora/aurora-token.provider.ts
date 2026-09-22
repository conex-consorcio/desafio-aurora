import { Injectable, Logger } from "@nestjs/common";

interface TokenRaw {
  accessToken: string;
  expiraEm: number;
}

/**
 * Guarda o token de acesso da Aurora.
 *
 * A Aurora mantem UM token valido por vez: emitir um novo invalida o anterior.
 */
@Injectable()
export class AuroraTokenProvider {
  private readonly logger = new Logger(AuroraTokenProvider.name);
  private readonly baseUrl = process.env.AURORA_BASE_URL ?? "http://localhost:4010";

  private token?: string;
  private expiraEmMs = 0;

  async obter(): Promise<string> {
    if (this.token && Date.now() < this.expiraEmMs) {
      return this.token;
    }
    return this.renovar();
  }

  /** Busca um token novo na Aurora. */
  async renovar(): Promise<string> {
    const resposta = await fetch(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: process.env.AURORA_CLIENT_ID ?? "victoria-pro",
        clientSecret:
          process.env.AURORA_CLIENT_SECRET ?? "dev-secret-nao-usar-em-producao",
        integrador: process.env.AURORA_INTEGRADOR ?? "plataforma",
      }),
    });

    if (!resposta.ok) {
      throw new Error(`aurora:auth status ${resposta.status}`);
    }

    const corpo = (await resposta.json()) as TokenRaw;

    this.token = corpo.accessToken;
    this.expiraEmMs = Date.now() + corpo.expiraEm * 1000;

    this.logger.log(`token renovado, valido por ${corpo.expiraEm}s`);

    return this.token;
  }
}
