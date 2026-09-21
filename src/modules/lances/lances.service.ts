import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@shared/prisma/prisma.service";
import { AuroraClient } from "@shared/aurora/aurora.client";

export interface RegistrarLanceInput {
  grupo: string;
  cota: string;
  assembleia: string;
}

export interface RegistrarLanceResultado {
  protocolo: string;
  jaRegistrado: boolean;
}

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
  async registrar(input: RegistrarLanceInput): Promise<RegistrarLanceResultado> {
    const existente = await this.prisma.lance.findFirst({
      where: {
        grupo: input.grupo,
        cota: input.cota,
        assembleia: input.assembleia,
      },
    });

    if (existente?.protocolo) {
      return { protocolo: existente.protocolo, jaRegistrado: true };
    }

    const resposta = await this.aurora.registrarLance(input);

    await this.prisma.lance.create({
      data: {
        grupo: input.grupo,
        cota: input.cota,
        assembleia: input.assembleia,
        protocolo: resposta.protocolo,
      },
    });

    this.logger.log(`lance registrado grupo=${input.grupo} cota=${input.cota}`);

    return { protocolo: resposta.protocolo, jaRegistrado: false };
  }
}
