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
./scripts/duas-instancias.sh          # sobe 3010 e 3011 contra o mesmo banco
API_URLS="http://localhost:3010,http://localhost:3011" npm run test:caso1
```

Passe o teste. Depois responda no PR: **o que acontece se o processo morrer
entre o momento em que ele decide registrar e a resposta da Aurora?**

---

## Caso 2 — Sincronizar 500 cotas *(escolha um: este ou o Caso 3)*

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

## CI

O CI da `main` está **vermelho de propósito** — ele roda os dois casos, e os
dois reproduzem problemas em aberto. O repositório não está quebrado.

O seu PR fica verde quando você resolve. Ele não roda lint nem cobertura: só
typecheck, build e os casos.

## Caso 3 — A manada de renovação de token *(escolha um: este ou o Caso 2)*

A Aurora mantém **um token válido por vez**: emitir um novo invalida o anterior.

Quando o token expira e há várias requisições em voo, cada uma percebe a
expiração e renova por conta própria — e cada renovação mata o token que a
anterior acabou de obter. Emitir token também não é barato do lado deles.

O teste em `test/caso-3-token.spec.ts` prova o problema. Ele falha hoje.

```bash
npm run test:caso3
```

Passe o teste. Depois responda no PR: **com oito instâncias da aplicação, quantas
renovações você espera ver quando o token expira? E isso é um problema?**

---

## Escolha

O **Caso 1 é obrigatório**. Entre o 2 e o 3, faça **um**.

Fazer os dois não vale mais que fazer um bem. A escolha também é avaliada:
diga no PR por que escolheu o que escolheu.

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

**Aqui se trabalha com Claude Code.** É a ferramenta do dia a dia do time, e
**o seu setup nela faz parte do que avaliamos** — skills, agentes, comandos, o
que você configurar e deixar no repositório.

Use outra ferramenta se preferir; ninguém vai impedir. Mas a parte da avaliação
que olha o seu ferramental vai olhar o que ficou versionado aqui.

Anexe o log das suas conversas (`AI-LOG.md`, links, colado, tanto faz). Não é
fiscalização: queremos ver como você conduz o modelo, não se você usou.

## Rodando

```bash
cp .env.example .env
docker compose up -d postgres redis aurora
npm install
npm run prisma:migrate
npm run prisma:generate
npm run prisma:seed
npm start
```

O `prisma:seed` popula o grupo `0001` com cotas elegíveis. Sem ele o
`LancesScheduler` roda e não encontra nada para fazer.

A Aurora sobe em `http://localhost:4010`. Ela expõe duas rotas de
instrumentação que os testes usam — e você também pode:

```bash
curl localhost:4010/_admin/chamadas     # quantas vezes cada chave foi chamada
curl -XPOST localhost:4010/_admin/reset
```

`stub/` é o mundo externo. **Não altere.**

## Dúvidas

Abra uma **issue**. Perguntar é bem-visto.
