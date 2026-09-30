/**
 * A chamada ao parceiro falhou.
 *
 * `efeitoDesconhecido` e a informacao que importa para quem chamou: a
 * requisicao pode ter chegado la?
 *
 * - `false`: a conexao nem abriu, ou o parceiro respondeu com erro. Ele nao
 *   processou o que pedimos (por convencao do contrato: resposta de erro e
 *   recusa, nao "fiz e depois falhei").
 * - `true`: enviamos e nao houve resposta (timeout, socket fechado no meio).
 *   O parceiro pode ter processado. Ninguem repete isto por conta propria.
 *
 * Na duvida, `true`: repetir um efeito cobrado custa mais que nao repetir.
 */
export class ParceiroFalhaError extends Error {
  constructor(
    readonly operacao: string,
    readonly motivo: string,
    readonly efeitoDesconhecido: boolean,
    readonly status?: number,
  ) {
    super(`[aurora:${operacao}] ${motivo}`);
    this.name = "ParceiroFalhaError";
  }
}

/** Codigos em que o sistema operacional garante que nada saiu pela rede. */
const CONEXAO_NAO_ABRIU = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Traduz o erro do `fetch` (undici) para ParceiroFalhaError. */
export function paraParceiroFalha(operacao: string, erro: unknown): ParceiroFalhaError {
  if (erro instanceof ParceiroFalhaError) return erro;

  const causa = erro instanceof Error ? (erro.cause as { code?: unknown } | undefined) : undefined;
  const codigo = typeof causa?.code === "string" ? causa.code : undefined;

  if (codigo && CONEXAO_NAO_ABRIU.has(codigo)) {
    return new ParceiroFalhaError(operacao, `conexao nao abriu (${codigo})`, false);
  }

  const motivo = erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro);
  return new ParceiroFalhaError(operacao, `sem resposta (${motivo})`, true);
}
