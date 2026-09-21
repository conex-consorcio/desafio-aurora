/**
 * O parceiro respondeu algo que nao bate com o contrato que conhecemos.
 *
 * Isto nao e erro do cliente nem bug nosso: e divergencia de contrato, e
 * precisa ser visivel. Ver ADR-0001.
 */
export class ContractViolationError extends Error {
  constructor(
    readonly operacao: string,
    readonly detalhe: string,
  ) {
    super(`[aurora:${operacao}] resposta fora do contrato: ${detalhe}`);
    this.name = "ContractViolationError";
  }
}
