## O que eu fiz

<!-- Uma visão geral. O diff conta o resto. -->

## Caso 1 — lance duplicado

**Abordagem:**

**Se o processo morrer entre a decisão de registrar e a resposta da Aurora, o que acontece?**

<!-- Esta pergunta vale tanto quanto o código. -->

## Caso 2 ou 3 — qual você escolheu, e por quê

<!-- A escolha é avaliada. -->

**Abordagem:**

**Se escolheu o 2 — o que acontece com uma sincronização em andamento quando o pod recebe SIGTERM?**

**Se escolheu o 3 — com oito instâncias, quantas renovações você espera quando o token expira? Isso é um problema?**

## O que eu descobri

<!-- Qualquer coisa sobre a Aurora, sobre o repositório ou sobre o problema
     que não estava no enunciado. Com evidência: payload, log, comando. -->

## O que ficou de fora, e por quê

<!-- Escopo honesto vale mais que escopo completo. -->

## O que eu NÃO validei

<!-- O que você fez mas não conseguiu provar. -->

## Tempo gasto

<!-- Honesto. Não premiamos quem virou a noite. -->

## Como conduzi a IA

<!-- Link ou caminho do AI-LOG.md. Em algum momento você discordou do modelo? -->

---

- [ ] `npm run test:caso1` passa com **duas** instâncias
- [ ] `npm run test:caso2` **ou** `npm run test:caso3` passa
- [ ] Não alterei os testes que vieram no repositório
