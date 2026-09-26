import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuroraClient } from '@shared/aurora/aurora.client';
import { ReservaLancePendenteError } from './reserva-lance-pendente.error';

export interface RegistrarLanceInput {
  grupo: string;
  cota: string;
  assembleia: string;
}

export interface RegistrarLanceResultado {
  protocolo: string;
  jaRegistrado: boolean;
}

const ESPERA_PROTOCOLO_MS = 5_000;
const INTERVALO_CONSULTA_MS = 100;

@Injectable()
export class LancesService {
  private readonly logger = new Logger(LancesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aurora: AuroraClient,
  ) {}

  /**
   * Registra o lance da cota na assembleia do mes.
   *
   * O lance so pode ser registrado UMA vez por cota por assembleia: o parceiro
   * cobra por lance e nao faz idempotencia do lado dele.
   */
  async registrar(
    input: RegistrarLanceInput,
  ): Promise<RegistrarLanceResultado> {
    const chave = {
      grupo: input.grupo,
      cota: input.cota,
      assembleia: input.assembleia,
    };

    try {
      await this.prisma.lance.create({ data: chave });
    } catch (erro) {
      if (
        erro instanceof Prisma.PrismaClientKnownRequestError &&
        erro.code === 'P2002'
      ) {
        return {
          protocolo: await this.aguardarProtocolo(chave),
          jaRegistrado: true,
        };
      }
      throw erro;
    }

    const resposta = await this.aurora.registrarLance(input);

    await this.prisma.lance.update({
      where: { grupo_cota_assembleia: chave },
      data: { protocolo: resposta.protocolo },
    });

    this.logger.log(`lance registrado grupo=${input.grupo} cota=${input.cota}`);

    return { protocolo: resposta.protocolo, jaRegistrado: false };
  }

  private async aguardarProtocolo(chave: RegistrarLanceInput): Promise<string> {
    const prazo = Date.now() + ESPERA_PROTOCOLO_MS;

    while (Date.now() < prazo) {
      const lance = await this.prisma.lance.findUnique({
        where: { grupo_cota_assembleia: chave },
      });

      if (lance?.protocolo) {
        return lance.protocolo;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, INTERVALO_CONSULTA_MS),
      );
    }

    throw new ReservaLancePendenteError(
      chave.grupo,
      chave.cota,
      chave.assembleia,
    );
  }
}
