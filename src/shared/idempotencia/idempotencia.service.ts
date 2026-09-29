import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@shared/prisma/prisma.service";

interface OpcoesEspera {
  intervaloMs?: number;
  tentativas?: number;
}

const INTERVALO_PADRAO_MS = 50;
const TENTATIVAS_PADRAO = 100; 

@Injectable()
export class IdempotenciaService {
  constructor(private readonly prisma: PrismaService) {}

  async executar<T>(
    chave: string,
    acao: () => Promise<T>,
    opcoes?: OpcoesEspera,
  ): Promise<T> {
    const claim = await this.reivindicar(chave);

    if (!claim.reivindicado) {
      return this.aguardar<T>(chave, opcoes);
    }

    try {
      const resultado = await acao();
      await this.prisma.chaveIdempotencia.update({
        where: { id: claim.id },
        data: { status: "CONCLUIDA", resultado: resultado as Prisma.InputJsonValue },
      });
      return resultado;
    } catch (erro) {
      await this.prisma.chaveIdempotencia.update({
        where: { id: claim.id },
        data: { status: "FALHOU", erro: erro instanceof Error ? erro.message : String(erro) },
      });
      throw erro;
    }
  }

  private async reivindicar(chave: string): Promise<{ reivindicado: boolean; id?: string }> {
    try {
      const row = await this.prisma.chaveIdempotencia.create({
        data: { chave, status: "PENDENTE" },
      });
      return { reivindicado: true, id: row.id };
    } catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === "P2002") {
        return { reivindicado: false };
      }
      throw erro;
    }
  }

  private async aguardar<T>(chave: string, opcoes?: OpcoesEspera): Promise<T> {
    const intervaloMs = opcoes?.intervaloMs ?? INTERVALO_PADRAO_MS;
    const tentativas = opcoes?.tentativas ?? TENTATIVAS_PADRAO;

    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
      const existente = await this.prisma.chaveIdempotencia.findUnique({ where: { chave } });

      if (existente?.status === "CONCLUIDA") {
        return existente.resultado as T;
      }
      if (existente?.status === "FALHOU") {
        throw new Error(existente.erro ?? `execução idempotente falhou: ${chave}`);
      }

      await new Promise((r) => setTimeout(r, intervaloMs));
    }

    throw new Error(`timeout aguardando execução idempotente: ${chave}`);
  }
}