import { Injectable, Logger } from "@nestjs/common";

interface TokenRaw {
  accessToken: string;
  expiraEm: number;
}

/**
 * Guarda o token de acesso da Aurora.
 *
 * A Aurora mantem UM token valido por vez: emitir um novo invalida o anterior.
 * Por isso a renovacao e single-flight dentro do processo: quem chega durante
 * uma emissao espera a mesma Promise em vez de emitir outra e matar o token
 * que o vizinho acabou de receber.
 */
@Injectable()
export class AuroraTokenProvider {
  private readonly logger = new Logger(AuroraTokenProvider.name);
  private readonly baseUrl = process.env.AURORA_BASE_URL ?? "http://localhost:4010";

  private token?: string;
  private expiraEmMs = 0;
  private renovacaoEmAndamento?: Promise<string>;

  async obter(): Promise<string> {
    if (this.token && Date.now() < this.expiraEmMs) {
      return this.token;
    }
    return this.renovar();
  }

  /**
   * Devolve um token novo.
   *
   * `tokenRejeitado` e o token que acabou de levar 401. Se ele ja nao e o
   * atual, outra chamada renovou nesse meio tempo e o atual serve -- emitir de
   * novo so invalidaria o que acabou de ser obtido.
   */
  async renovar(tokenRejeitado?: string): Promise<string> {
    if (this.renovacaoEmAndamento) {
      return this.renovacaoEmAndamento;
    }

    if (tokenRejeitado !== undefined && this.token && this.token !== tokenRejeitado) {
      return this.token;
    }

    this.renovacaoEmAndamento = this.emitir().finally(() => {
      this.renovacaoEmAndamento = undefined;
    });

    return this.renovacaoEmAndamento;
  }

  /** Busca um token novo na Aurora. */
  private async emitir(): Promise<string> {
    const resposta = await fetch(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: process.env.AURORA_CLIENT_ID ?? "parceiro-demo",
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
