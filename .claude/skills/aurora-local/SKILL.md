---
name: aurora-local
description: Sobe e opera o ambiente local do desafio (Postgres, Redis, stub da Aurora, duas instancias da API) e roda cada caso com os contadores do stub. Use antes de rodar qualquer caso, quando o stub parece fora do ar, ou para reproduzir o CI localmente.
---

# Ambiente local do desafio

O CI e a referencia; isto reproduz o CI na maquina. Comandos testados em
Linux com nvm.

## Pre-requisitos

```bash
nvm use 22                      # .nvmrc; a maquina pode ter outro Node padrao
cp -n .env.example .env
docker compose up -d postgres redis aurora
npm install && npm run prisma:migrate && npm run prisma:generate && npm run prisma:seed
```

Os containers caem com a maquina. `docker compose ps` antes de culpar o codigo.

## Verificacoes rapidas

```bash
npm run typecheck && npx jest --runInBand src     # como o CI, antes do stub subir
set -a; source .env; set +a
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma
```

O `migrate diff` tem que dizer "No difference detected": migration escrita a
mao e schema andam juntos.

## Duas instancias (Caso 1 precisa)

```bash
npx nest build
PORT=3010 node dist/main.js & PORT=3011 node dist/main.js &
# warmup como o CI faz (a segunda instancia sobe SEM token: o lance _warmup ja existe)
for p in 3010 3011; do curl -sf -o /dev/null -XPOST localhost:$p/lances/registrar \
  -H 'content-type: application/json' -d '{"grupo":"_warmup","cota":"0","assembleia":"0"}'; done
```

## Os casos

```bash
API_URLS="http://localhost:3010,http://localhost:3011" npm run test:caso1
APP_URL=http://localhost:3010 npm run test:caso2       # ~30s com AURORA_MAX_CONCORRENCIA=10
APP_URL=http://localhost:3010 npm run test:caso3
```

Cada spec zera os contadores do stub no `beforeAll`. Para ler o que sobrou:

```bash
curl -s localhost:4010/_admin/chamadas   # chamadas por chave, picoConcorrencia, recusas429, limite
curl -s -XPOST localhost:4010/_admin/reset
```

## Armadilhas

- `stub/` e `test/` nao se alteram. Se um teste parece errado, o problema e nosso.
- A migration de unicidade falha em banco com lances ou cotas duplicados
  (rodadas antigas do baseline). Limpar antes:
  `docker compose exec -T postgres psql -U aurora -d aurora -c "DELETE FROM lances a USING lances b WHERE a.ctid < b.ctid AND a.grupo=b.grupo AND a.cota=b.cota AND a.assembleia=b.assembleia"`
- `GET /cotas/:grupo/pendurada` nunca e alcancado: `/cotas/:grupo/:numero` esta
  registrada antes no Express e captura `pendurada`. O timeout do cliente se
  prova com fake, nao com o stub.
- `/parceiros` devolve um campo de senha. Nao logar payload cru.
