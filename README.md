# Desafio Aurora

Repositório de trabalho. NestJS + TypeScript + Prisma/Postgres + Redis.

A **Aurora Consórcios** é a fonte oficial dos nossos dados. Ela roda localmente
via Docker. O módulo `src/modules/parceiros` já está integrado — use-o como
referência de como escrevemos código aqui.

**Não há pegadinha neste desafio.** Os dois problemas estão descritos abaixo,
abertamente. A dificuldade está na solução, não em descobrir qual é o problema.

---

## Caso 1 — O lance duplicado *(obrigatório)*

`LancesScheduler` roda `@Cron("0 6 1 * *")`: dia 1 de cada mês, às 6h, registra
o lance de toda cota elegível.

O scheduler roda em **toda instância da aplicação**. Em produção são oito.
Todas acordam no mesmo segundo, leem as mesmas cotas e chamam a Aurora.

**A Aurora cobra por lance registrado e não faz idempotência.** Dois lances na
mesma cota são dois lances cobrados — e o segundo pode invalidar o primeiro.

O teste em `test/caso-1-lance-duplicado.spec.ts` prova o problema. Ele falha
hoje. Suba duas instâncias contra o mesmo banco:

```bash
PORT=3010 npm start
PORT=3011 npm start
API_URLS="http://localhost:3010,http://localhost:3011" npm run test:caso1
```

Passe o teste. Depois responda no PR: **o que acontece se o processo morrer
entre o momento em que ele decide registrar e a resposta da Aurora?**

---

## Caso 2 — Sincronizar 500 cotas *(obrigatório)*

`POST /cotas-sync/:grupo` busca o detalhe das 500 cotas de um grupo.

A Aurora:

- responde entre 200ms e 900ms por cota;
- aceita um número limitado de requisições simultâneas — acima dele responde
  `429` com `Retry-After`;
- tem uma rota que **nunca responde**.

O teste em `test/caso-2-sincronizacao.spec.ts` prova o problema. Hoje três dos
quatro casos falham.

```bash
npm run test:caso2
```

O quarto — *"não resolve serializando tudo"* — **já passa hoje**, e é de
propósito: ele existe para barrar a correção preguiçosa de mandar uma cota por
vez. Ele tem que continuar passando no fim.

Passe o teste. Depois responda no PR: **o que acontece com uma sincronização em
andamento quando o pod recebe SIGTERM?**

---

## Como entregar

Abra um **Pull Request** contra `main`.

O PR precisa conter:

| Item | Por quê |
|---|---|
| Os testes dos dois casos passando | é o contrato |
| **Testes seus**, além dos que vieram prontos | os que vieram não são exaustivos |
| Resposta escrita às duas perguntas acima | elas valem tanto quanto o código |
| O que ficou de fora e por quê | escopo honesto |
| O que você **não** validou | idem |
| `AI-LOG.md` | ver abaixo |

## Timebox

**4 horas.** Se passar disso, tudo bem — mas **diga no PR quanto levou**.
Não premiamos quem virou a noite.

## Ferramentas

**Use IA à vontade.** Claude Code, Cursor, o que você usa no dia a dia — é
assim que trabalhamos aqui.

Anexe o log das suas conversas (`AI-LOG.md`, links, colado, tanto faz). Não é
fiscalização: queremos ver como você conduz o modelo, não se você usou.

## Rodando

```bash
cp .env.example .env
docker compose up -d postgres redis aurora
npm install
npm run prisma:migrate
npm run prisma:generate
npm start
```

A Aurora sobe em `http://localhost:4010`. Ela expõe duas rotas de
instrumentação que os testes usam — e você também pode:

```bash
curl localhost:4010/_admin/chamadas     # quantas vezes cada chave foi chamada
curl -XPOST localhost:4010/_admin/reset
```

`stub/` é o mundo externo. **Não altere.**

## Dúvidas

Abra uma **issue**. Perguntar é bem-visto.
