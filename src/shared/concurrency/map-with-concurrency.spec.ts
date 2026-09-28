import { describe, expect, it } from "@jest/globals";
import { ConcurrencyInterruptedError, mapWithConcurrency } from "./map-with-concurrency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("nunca supera o limite de concorrencia e preserva a ordem", async () => {
    let emVoo = 0;
    let pico = 0;

    const map = async (item: number): Promise<number> => {
      emVoo += 1;
      pico = Math.max(pico, emVoo);
      await sleep(10);
      emVoo -= 1;
      return item * 2;
    };

    const items = Array.from({ length: 30 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 4, map);

    expect(pico).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(30);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  it("lança ConcurrencyInterruptedError e espera as que estão em voo", async () => {
    const emVoo: Array<() => void> = [];
    let interrupted = false;

    const map = () =>
      new Promise<number>((resolve) => {
        emVoo.push(() => resolve(1));
      });

    const pending = mapWithConcurrency([1, 2, 3, 4], 2, map, () => interrupted);

    await sleep(5);
    expect(emVoo).toHaveLength(2);

    interrupted = true;
    emVoo.forEach((finish) => finish());

    await expect(pending).rejects.toBeInstanceOf(ConcurrencyInterruptedError);
  });

  it("no despacha nada se ja estava interrompido", async () => {
    const map = jest.fn(async (item: number) => item);

    await expect(
      mapWithConcurrency([1, 2], 2, map, () => true),
    ).rejects.toBeInstanceOf(ConcurrencyInterruptedError);

    expect(map).not.toHaveBeenCalled();
  });

  it("no interrompe se o flag chega quando tudo ja terminou", async () => {
    let interrupted = false;
    const map = async (item: number): Promise<number> => item;

    const pending = mapWithConcurrency([1, 2], 2, map, () => interrupted);
    interrupted = true;

    expect(await pending).toEqual([1, 2]);
  });
});