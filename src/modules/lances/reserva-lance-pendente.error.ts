/**
 * Outra execucao reservou o lance e o protocolo nao apareceu no prazo.
 *
 * A reserva nao e desfeita automaticamente: a Aurora pode ter cobrado o lance.
 * Resolver exige reconciliacao.
 */
export class ReservaLancePendenteError extends Error {
  constructor(
    readonly grupo: string,
    readonly cota: string,
    readonly assembleia: string,
  ) {
    super(
      `lance com reserva pendente e sem protocolo grupo=${grupo} cota=${cota} assembleia=${assembleia}`,
    );
    this.name = 'ReservaLancePendenteError';
  }
}
