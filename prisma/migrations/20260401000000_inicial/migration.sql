CREATE TABLE "parceiros" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "parceiros_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "parceiros_codigo_key" ON "parceiros"("codigo");

CREATE TABLE "lances" (
    "id" TEXT NOT NULL,
    "grupo" TEXT NOT NULL,
    "cota" TEXT NOT NULL,
    "assembleia" TEXT NOT NULL,
    "protocolo" TEXT,
    "registradoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cotas" (
    "id" TEXT NOT NULL,
    "grupo" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "situacao" TEXT NOT NULL,
    "valorCredito" INTEGER,
    "sincronizadaEm" TIMESTAMP(3),
    CONSTRAINT "cotas_pkey" PRIMARY KEY ("id")
);
