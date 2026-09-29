import { CotasSyncService } from "@modules/cotas-sync/cotas-sync.service";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3010));

  let apagando = false;

  const apagar = async (senal: string) => {
    if (apagando) return;
    apagando = true;

    Logger.log(`recebido ${senal}, apagando...`, "main");

    // Drena primeiro: deixa de despachar, espera o que está em voo (limitado
    // pelo timeout) e só então fecha o servidor. Sem isto, o NestJS corta as
    // conexões activas antes de responder.
    const sync = app.get(CotasSyncService);
    await sync.terminar();
    await app.close();
  };

  process.on("SIGTERM", () => void apagar("SIGTERM"));
  process.on("SIGINT", () => void apagar("SIGINT"));
}

void bootstrap();