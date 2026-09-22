import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Popula o grupo 0001 com cotas elegiveis.
 *
 * Sem isto o `LancesScheduler` roda e nao encontra nada para fazer -- o cron
 * existe, mas o caminho fica morto.
 */
async function main(): Promise<void> {
  const GRUPO = "0001";
  const TOTAL = 30;

  await prisma.cota.deleteMany({ where: { grupo: GRUPO } });

  await prisma.cota.createMany({
    data: Array.from({ length: TOTAL }, (_, i) => ({
      grupo: GRUPO,
      numero: String(i + 1).padStart(4, "0"),
      situacao: i % 5 === 0 ? "VENDIDA" : "DISPONIVEL",
      valorCredito: 8_990_000,
    })),
  });

  const elegiveis = await prisma.cota.count({
    where: { grupo: GRUPO, situacao: "DISPONIVEL" },
  });

  console.log(`grupo ${GRUPO}: ${TOTAL} cotas, ${elegiveis} elegiveis a lance`);
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
