import { describe, expect, it } from '@jest/globals';

import { LancesScheduler } from './lances.scheduler';
import type { LancesService, RegistrarLanceInput } from './lances.service';
import { ReservaLancePendenteError } from './reserva-lance-pendente.error';
import type { PrismaService } from '@shared/prisma/prisma.service';

const prisma = {
  cota: {
    findMany: async () => [
      { grupo: '0001', numero: '0001' },
      { grupo: '0001', numero: '0002' },
    ],
  },
} as unknown as PrismaService;

function lancesQueFalhamNaPrimeira(falha: Error) {
  const tentadas: string[] = [];
  const lances = {
    async registrar(input: RegistrarLanceInput) {
      tentadas.push(input.cota);
      if (input.cota === '0001') throw falha;
      return { protocolo: 'PRT-1', jaRegistrado: false };
    },
  } as unknown as LancesService;

  return { lances, tentadas };
}

describe('LancesScheduler', () => {
  it('pula a cota com reserva pendente e segue para a proxima', async () => {
    const { lances, tentadas } = lancesQueFalhamNaPrimeira(
      new ReservaLancePendenteError('0001', '0001', '2026-09'),
    );

    await new LancesScheduler(prisma, lances).registrarLancesDoMes();

    expect(tentadas).toEqual(['0001', '0002']);
  });

  it('interrompe a execucao quando a falha nao e reserva pendente', async () => {
    const falha = new Error('aurora fora');
    const { lances, tentadas } = lancesQueFalhamNaPrimeira(falha);

    await expect(
      new LancesScheduler(prisma, lances).registrarLancesDoMes(),
    ).rejects.toBe(falha);
    expect(tentadas).toEqual(['0001']);
  });
});
