import { Injectable } from "@nestjs/common";
import { AuroraClient } from "@shared/aurora/aurora.client";
import type { CotaFonte } from "./cotas-sync.service";

/** Adaptador HTTP da porta CotaFonte. Nao interpreta nada. */
@Injectable()
export class AuroraCotaFonte implements CotaFonte {
  constructor(private readonly aurora: AuroraClient) {}

  buscar(grupo: string, numero: string): Promise<unknown> {
    return this.aurora.detalheCota(grupo, numero);
  }
}
