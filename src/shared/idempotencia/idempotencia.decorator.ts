import { IdempotenciaService } from "./idempotencia.service";

interface OpcoesIdempotente {
  intervaloMs?: number;
  tentativas?: number;
}

export function Idempotente<TArgs extends unknown[]>(
  gerarChave: (...args: TArgs) => string,
  opcoes?: OpcoesIdempotente,
) {
  return function (_target: object, propertyKey: string, descriptor: PropertyDescriptor) {
    const original = descriptor.value as (...args: TArgs) => Promise<unknown>;

    descriptor.value = async function (this: Record<string, unknown>, ...args: TArgs) {
      const servico = this.idempotencia as IdempotenciaService | undefined;

      if (!servico || !(servico instanceof IdempotenciaService)) {
        throw new Error(
          `@Idempotente em ${this.constructor.name}.${propertyKey} exige uma propriedade ` +
            `"idempotencia: IdempotenciaService" injetada na classe.`,
        );
      }

      return servico.executar(gerarChave(...args), () => original.apply(this, args), opcoes);
    };

    return descriptor;
  };
}