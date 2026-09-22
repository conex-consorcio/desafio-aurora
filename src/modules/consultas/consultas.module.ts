import { Module } from "@nestjs/common";
import { ConsultasController } from "./consultas.controller";

@Module({ controllers: [ConsultasController] })
export class ConsultasModule {}
