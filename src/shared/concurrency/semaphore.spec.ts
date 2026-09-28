import { describe, expect, it } from "@jest/globals";
import { Semaphore } from "./semaphore";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Semaphore", () => {
  it("deixa passar ate N adquirentes ao mesmo tempo", async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();

    let released = false;
    const third = semaphore.acquire().then(() => {
      released = true;
    });

    await sleep(10);
    expect(released).toBe(false);

    semaphore.release();
    await third;
    expect(released).toBe(true);
  });

  it("cede a permissão ao que espera, não o acumula", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();

    let released = false;
    const waiting = semaphore.acquire().then(() => {
      released = true;
    });

    await sleep(5);
    expect(released).toBe(false);

    semaphore.release();
    await waiting;
    expect(released).toBe(true);

    // A permissão foi para o que esperava: adquirir de novo bloqueia.
    let again = false;
    const next = semaphore.acquire().then(() => {
      again = true;
    });
    await sleep(5);
    expect(again).toBe(false);
    semaphore.release();
    await next;
  });

  it("recusa menos de 1 permissão", () => {
    expect(() => new Semaphore(0)).toThrow(Error);
    expect(() => new Semaphore(-1)).toThrow(Error);
    expect(() => new Semaphore(Number.NaN)).toThrow(Error);
  });
});