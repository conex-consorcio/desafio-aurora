import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { AuroraTokenProvider } from './aurora-token.provider';

const fetchOriginal = globalThis.fetch;

let chamadas = 0;
let isIndisponivel = false;

beforeEach(() => {
  chamadas = 0;
  isIndisponivel = false;

  globalThis.fetch = async () => {
    chamadas += 1;
    if (isIndisponivel) return new Response(null, { status: 503 });
    return Response.json({ accessToken: `token-${chamadas}`, expiraEm: 300 });
  };
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe('AuroraTokenProvider', () => {
  it('emite um unico token quando varias requisicoes rejeitam o mesmo', async () => {
    const provider = new AuroraTokenProvider();
    const rejeitado = await provider.obter();

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => provider.renovar(rejeitado)),
    );

    expect(chamadas).toBe(2);
    expect(tokens).toEqual(Array(5).fill('token-2'));
  });

  it('reaproveita o token novo quando o 401 do antigo chega depois da renovacao', async () => {
    const provider = new AuroraTokenProvider();
    const antigo = await provider.obter();
    const novo = await provider.renovar(antigo);

    expect(await provider.renovar(antigo)).toBe(novo);
    expect(chamadas).toBe(2);
  });

  it('espera a renovacao em andamento quando o 401 atrasado e de um token ja substituido', async () => {
    const provider = new AuroraTokenProvider();
    const t0 = await provider.obter();
    const t1 = await provider.renovar(t0);

    let liberarEmissao = () => {};
    const emissaoPresa = new Promise<void>((resolve) => {
      liberarEmissao = resolve;
    });
    globalThis.fetch = async () => {
      chamadas += 1;
      await emissaoPresa;
      return Response.json({ accessToken: 'token-3', expiraEm: 300 });
    };

    const renovacaoDeT1 = provider.renovar(t1);
    const atrasada = provider.renovar(t0);
    liberarEmissao();

    expect(await atrasada).toBe('token-3');
    expect(await renovacaoDeT1).toBe('token-3');
    expect(chamadas).toBe(3);
  });

  it('tenta emitir de novo depois que uma renovacao falha', async () => {
    const provider = new AuroraTokenProvider();
    isIndisponivel = true;

    const falhas = await Promise.allSettled([
      provider.renovar(),
      provider.renovar(),
    ]);

    expect(falhas.map((f) => f.status)).toEqual(['rejected', 'rejected']);
    expect(chamadas).toBe(1);

    isIndisponivel = false;

    expect(await provider.renovar()).toBe('token-2');
  });
});
