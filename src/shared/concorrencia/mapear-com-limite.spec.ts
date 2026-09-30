import { describe, expect, it } from "@jest/globals";

import { mapearComLimite } from "./mapear-com-limite";

function tarefaQueMedeSimultaneas(atrasoMs = 5) {
  let emVoo = 0;
  let pico = 0;
  const vistos: number[] = [];
  const tarefa = async (item: number) => {
    emVoo += 1;
    pico = Math.max(pico, emVoo);
    await new Promise((ok) => setTimeout(ok, atrasoMs));
    vistos.push(item);
    emVoo -= 1;
  };
  return { tarefa, pico: () => pico, vistos };
}

describe("mapearComLimite", () => {
  const itens = Array.from({ length: 37 }, (_, i) => i);

  it("processa todos os itens sem passar do limite", async () => {
    const medidor = tarefaQueMedeSimultaneas();

    await mapearComLimite(itens, 4, medidor.tarefa);

    expect(medidor.pico()).toBe(4);
    expect([...medidor.vistos].sort((a, b) => a - b)).toEqual(itens);
  });

  it("termina o que esta em maos e devolve o resto quando mandam parar", async () => {
    const medidor = tarefaQueMedeSimultaneas(20);
    const controle = new AbortController();

    const execucao = mapearComLimite(itens, 4, medidor.tarefa, controle.signal);
    await new Promise((ok) => setTimeout(ok, 5));
    controle.abort();
    const { naoIniciados } = await execucao;

    expect(medidor.vistos).toHaveLength(4);
    expect(naoIniciados).toHaveLength(itens.length - 4);
  });

  it("recusa limite que nao seja inteiro positivo", async () => {
    await expect(mapearComLimite(itens, 0, async () => undefined)).rejects.toBeInstanceOf(RangeError);
  });
});
