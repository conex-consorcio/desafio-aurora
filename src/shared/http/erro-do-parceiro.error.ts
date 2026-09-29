/** Erro vindo da chamada HTTP ao parceiro. `status` undefined = falha de rede. */
export class ErroDoParceiro extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ErroDoParceiro";
  }
}

/** O parceiro nao respondeu dentro do tempo limite (abort da chamada). */
export class TimeoutParceiroError extends ErroDoParceiro {
  constructor() {
    super("parceiro nao respondeu dentro do tempo limite");
    this.name = "TimeoutParceiroError";
  }
}