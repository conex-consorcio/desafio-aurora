import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from '@jest/globals';

import { LancesService } from './lances.service';
import { ReservaLancePendenteError } from './reserva-lance-pendente.error';
import {
  AuroraClient,
  type RegistrarLanceResponse,
} from '@shared/aurora/aurora.client';
import { AuroraTokenProvider } from '@shared/aurora/aurora-token.provider';
import { PrismaService } from '@shared/prisma/prisma.service';

const prisma = new PrismaService();

class AuroraQueConta extends AuroraClient {
  chamadas = 0;

  constructor() {
    super(new AuroraTokenProvider());
  }

  override async registrarLance(): Promise<RegistrarLanceResponse> {
    this.chamadas += 1;
    await dormir(200);
    return { protocolo: `PRT-${this.chamadas}`, vezRegistrada: this.chamadas };
  }
}

function dormir(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lanceNovo() {
  return { grupo: '9001', cota: '0042', assembleia: `teste-${randomUUID()}` };
}

afterAll(() => prisma.$disconnect());

describe('LancesService', () => {
  it('registra na Aurora uma unica vez quando a mesma cota e disputada', async () => {
    const aurora = new AuroraQueConta();
    const lance = lanceNovo();

    const resultados = await Promise.all([
      new LancesService(prisma, aurora).registrar(lance),
      new LancesService(prisma, aurora).registrar(lance),
    ]);

    expect(aurora.chamadas).toBe(1);
    expect(resultados.map((r) => r.protocolo)).toEqual(['PRT-1', 'PRT-1']);
    expect(resultados.map((r) => r.jaRegistrado).sort()).toEqual([false, true]);
  });

  it('espera a reserva do vencedor e devolve o protocolo dele sem chamar a Aurora', async () => {
    const aurora = new AuroraQueConta();
    const lance = lanceNovo();
    await prisma.lance.create({ data: lance });

    const perdedor = new LancesService(prisma, aurora).registrar(lance);
    await dormir(300);
    await prisma.lance.update({
      where: { grupo_cota_assembleia: lance },
      data: { protocolo: 'PRT-vencedor' },
    });

    expect(await perdedor).toEqual({
      protocolo: 'PRT-vencedor',
      jaRegistrado: true,
    });
    expect(aurora.chamadas).toBe(0);
  });

  it('acusa a reserva pendente quando o protocolo nunca chega', async () => {
    const aurora = new AuroraQueConta();
    const lance = lanceNovo();
    await prisma.lance.create({ data: lance });

    await expect(
      new LancesService(prisma, aurora).registrar(lance),
    ).rejects.toBeInstanceOf(ReservaLancePendenteError);
    expect(aurora.chamadas).toBe(0);
  });
});
