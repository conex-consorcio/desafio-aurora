import { Global, Module } from "@nestjs/common";
import { AuroraClient } from "./aurora.client";
import { AuroraTokenProvider } from "./aurora-token.provider";

@Global()
@Module({
  providers: [AuroraTokenProvider, AuroraClient],
  exports: [AuroraTokenProvider, AuroraClient],
})
export class AuroraModule {}
