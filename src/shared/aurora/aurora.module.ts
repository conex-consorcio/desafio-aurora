import { Global, Module } from "@nestjs/common";
import { AuroraClient } from "./aurora.client";

@Global()
@Module({
  providers: [AuroraClient],
  exports: [AuroraClient],
})
export class AuroraModule {}
