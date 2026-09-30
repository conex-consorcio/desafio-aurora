import { Injectable } from "@nestjs/common";
import { AuroraClient } from "@shared/aurora/aurora.client";
import type { LanceRegistrador, RegistrarLanceInput } from "./lances.service";

/** Adaptador HTTP da porta LanceRegistrador. Nao interpreta nada. */
@Injectable()
export class AuroraLanceRegistrador implements LanceRegistrador {
  constructor(private readonly aurora: AuroraClient) {}

  registrar(input: RegistrarLanceInput): Promise<unknown> {
    return this.aurora.registrarLance(input);
  }
}
