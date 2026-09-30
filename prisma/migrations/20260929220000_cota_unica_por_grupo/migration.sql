-- Uma cota por (grupo, numero): a sincronizacao passa a fazer upsert, e
-- rodar duas vezes o mesmo grupo nao pode duplicar o roster.
CREATE UNIQUE INDEX "cotas_grupo_numero_key" ON "cotas"("grupo", "numero");
