import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Sem isto, SIGTERM mata o processo na hora e o que estava em voo com o
  // parceiro e abandonado no meio. Com isto, o Nest chama os hooks de
  // desligamento e so depois fecha o servidor.
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3010));
}

void bootstrap();
