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
  private readonly baseUrl =
    process.env.AURORA_BASE_URL ?? "http://localhost:4010";

  private token: string | null = null;
  private expiraEmMs = 0;

  private renovacaoEmAndamento: Promise<string> | null = null;

  async obter(): Promise<string> {
    if (this.token && Date.now() < this.expiraEmMs) {
      return this.token;
    }

    return this.renovar();
  }
  
  async renovar(): Promise<string> {
    if (this.renovacaoEmAndamento) {
      return this.renovacaoEmAndamento;
    }

    this.renovacaoEmAndamento = this.emitirToken();

    try {
      return await this.renovacaoEmAndamento;
    } finally {
      this.renovacaoEmAndamento = null;
    }
  }

  private async emitirToken(): Promise<string> {
    const resposta = await fetch(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId: "parceiro-demo",
        clientSecret: "dev-secret-nao-usar-em-producao",
      }),
    });

    if (!resposta.ok) {
      throw new Error(`aurora:auth/token status ${resposta.status}`);
    }

    const dados = (await resposta.json()) as {
      accessToken: string;
      expiraEm: number;
    };

    this.token = dados.accessToken;
    this.expiraEmMs = Date.now() + dados.expiraEm * 1000;

    return dados.accessToken;
  }
}