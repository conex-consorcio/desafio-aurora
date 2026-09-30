# ADR-0004 — O parceiro tem limite, a rede tem prazo e o processo tem fim

- **Status:** aceito
- **Data:** 2026-09-29

## Contexto

A Aurora aceita um número limitado de requisições simultâneas, **compartilhado
por todas as nossas instâncias** (confirmado com a Aurora em 2026-09-28), e
acima dele responde `429` com `Retry-After`. Cada consulta de cota leva de 200
a 900ms. Parceiros também têm rotas que nunca respondem.

A sincronização de um grupo disparava 500 consultas de uma vez
(`Promise.all`): no baseline, 475 recusas e a sincronização inteira caía na
primeira. Nenhum `fetch` tinha timeout. Nada era gravado até o fim. E
`main.ts` não habilitava os hooks de desligamento: um `SIGTERM` matava o
processo com consultas em voo.

## Decisão

1. **Concorrência limitada por instância**, num pool que puxa de uma fila
   (`mapearComLimite`), com o teto em `AURORA_MAX_CONCORRENCIA` (padrão 10).
   Como o limite do parceiro é da frota, o valor por instância precisa caber
   em `limite ÷ instâncias`. Coordenar isso entre instâncias (semáforo
   compartilhado) fica fora deste ADR.

2. **Timeout em toda chamada** (`AbortSignal.timeout`, 10s), acima do p100
   observado com folga. Timeout curto seguido de repetição faz o parceiro
   processar a mesma coisa duas vezes.

3. **Repetir só o que certamente não teve efeito.** `429`, `5xx` e conexão
   recusada repetem (até 3 tentativas), esperando o `Retry-After` quando ele
   vem. Timeout não repete. A mesma classificação do ADR-0003.

4. **Gravar cada cota assim que chega**, por `upsert` em `(grupo, numero)`.
   Uma falha no meio não perde o que já veio; rodar de novo completa o que
   falta em vez de duplicar.

5. **Desligar drenando.** Com `enableShutdownHooks`, ao receber `SIGTERM` o
   service para de consultar cotas novas, espera as em voo (limitadas por
   `limite` e pelo timeout), grava o que chegou e responde com
   `sincronizadas` e `pendentes`. Prazo de drenagem de 20s, dentro dos 30s de
   graça padrão do Kubernetes (premissa não confirmada com a infra).

## Consequências

- A resposta de `POST /cotas-sync/:grupo` deixou de ser um número: passou a
  ser `{ sincronizadas, falhas?, pendentes? }`. Parcial é visível, não erro.
- Uma sincronização de 500 cotas leva ~30s com teto 10. Continua sendo uma
  requisição HTTP longa; a direção de produção é virar um job com progresso,
  fora deste ADR.
- Com oito instâncias e teto 10 em cada, a frota ultrapassa o limite da
  Aurora. Até haver coordenação, o valor por instância tem que ser ajustado à
  mão para a frota (2 por instância com limite 20, ou menos instâncias
  sincronizando).
