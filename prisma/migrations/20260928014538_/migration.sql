/*
  Warnings:

  - You are about to drop the `lances` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "lances";

-- CreateTable
CREATE TABLE "chaves_idempotencia" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "resultado" JSONB,
    "erro" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chaves_idempotencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lance" (
    "id" TEXT NOT NULL,
    "grupo" TEXT NOT NULL,
    "cota" TEXT NOT NULL,
    "assembleia" TEXT NOT NULL,
    "protocolo" TEXT,
    "registradoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chaves_idempotencia_chave_key" ON "chaves_idempotencia"("chave");

-- CreateIndex
CREATE UNIQUE INDEX "Lance_grupo_cota_assembleia_key" ON "Lance"("grupo", "cota", "assembleia");
