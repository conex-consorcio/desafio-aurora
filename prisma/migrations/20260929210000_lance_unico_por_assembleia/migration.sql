-- Um lance por (grupo, cota, assembleia). A linha passa a nascer como
-- RESERVA (situacao PENDENTE, sem protocolo) antes da chamada ao parceiro, e
-- so vira REGISTRADO quando o protocolo chega. A constraint e o que impede
-- duas instancias de reservarem a mesma chave.
CREATE TYPE "SituacaoLance" AS ENUM ('PENDENTE', 'REGISTRADO');

ALTER TABLE "lances"
  ADD COLUMN "situacao" "SituacaoLance" NOT NULL DEFAULT 'PENDENTE',
  ADD COLUMN "reservadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "registradoEm" DROP NOT NULL,
  ALTER COLUMN "registradoEm" DROP DEFAULT;

-- Linhas anteriores a esta migration so existiam com protocolo: sao lances
-- registrados de fato.
UPDATE "lances" SET "situacao" = 'REGISTRADO' WHERE "protocolo" IS NOT NULL;

CREATE UNIQUE INDEX "lances_grupo_cota_assembleia_key"
  ON "lances"("grupo", "cota", "assembleia");
