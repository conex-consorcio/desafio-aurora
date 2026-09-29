# Análise de crash nos Casos 1 e 2

Respostas às perguntas do enunciado, com base no código atual. Esta análise
está pronta para o PR; a correção da janela do Caso 1 foi **documentada, não
implementada** (ver o porquê no fim de cada seção).

## Caso 1 — o processo morre entre decidir registrar e a resposta da Aurora

### O que acontece hoje

A arbitragem protege contra **concorrência entre instâncias**, não contra
**crash na janela**:

- o lock distribuído (`SET NX PX 15s`), a flag `finishing` (`PX 40s`) e a
  chave de resultado garantem que, entre instâncias vivas, uma única chama a
  Aurora e as demais aguardam o protocolo;
- mas a linha no banco e a chave de resultado só são gravadas **depois** de a
  Aurora confirmar o lance (lances.service.ts:134-142).

Se o processo morre **depois** de a Aurora registrar (e cobrar) e **antes** de
persistir o `protocolo`, não sobra nenhum registro para deduplicar. O reaper
(`RETOMAR_ORFANOS`, lances.worker.ts:43) devolve a cota à fila, outro worker
reclama e chama a Aurora de novo → **lance cobrado duas vezes**. A Aurora não
faz idempotência e não expõe rota de consulta do lance, então não há como
distinguir "a Aurora nunca recebeu" de "a Aurora recebeu e cobrou".

### Qual seria a correção (documentada, não implementada)

Máquina de estados por cota, em Redis (e, idealmente, espelhada no banco):

```
pega → processing → [chama Aurora → salva banco] → concluido
                      ↓ falhou
                     error
```

- O "pega" marca `processing` no Redis e a linha `PENDENTE` no banco **antes**
  de qualquer efeito externo — a decisão vira durável;
- no sucesso, `concluido:<protocolo>`; em erro explícito, `error`;
- **gate no re-claim:** `concluido` → dedupe; `processing` travado (dono morreu
  no meio) ou `error` → **nunca re-chama a Aurora**, roteia para reconciliação.

Limitação fundamental: sem idempotência nem rota de consulta no parceiro,
exactly-once é impossível. A janela de crash entre a resposta da Aurora e o
INSERT pode ser *detectada* e enviada à reconciliação, mas não *resolvida*
automaticamente. Um falso-ambíguo residual (criou a linha mas o processo
morreu antes do `fetch`) barra um lance legítimo sem cobrança — custo aceitável
porque erra para o lado de "não cobrar".

### Por que não implementamos

O checklist do PR exige *"Não alterei os testes que vieram no repositório"* e
optamos por não alterar o schema. A correção exigiria:

- ajustar os specs de unidade que vieram (`lances.service.spec.ts` e
  `lances.worker.spec.ts` asserem as chaves `lock/finishing/resultado` e o
  retry de erros transitórios), e/ou
- migration no banco (`Lance.estado` + índice único), que por si não quebra os
  testes de integração (o CI aplica `prisma migrate deploy`), mas tocaria o
  schema.

Decisão: registrar a questão aqui em vez de quebrar o contrato do desafio.

## Caso 2 — sincronização em andamento quando o pod recebe SIGTERM

### O que acontece hoje

`main.ts` recebe SIGTERM/SIGINT → `sync.terminar()` marca `draining=true` e
espera `Promise.allSettled([...emVoo])` **antes** de `app.close()`
(cotas-sync.service.ts:36-39 e main.ts:22-24).

- `mapWithConcurrency` para de despachar cotas novas; as que estão em voo
  terminam limitadas pelo timeout (`AbortController`, `AURORA_TIMEOUT_MS=10s`)
  e pelo retry defensivo de 429;
- quem espera um slot do `LimiteGlobal` aborta em vez de seguir esperando;
- a escrita é um único `createMany` em transação, **all-or-nothing**, que só
  roda se as 500 buscas completarem → **nada parcial é persistido**; o cliente
  recebe erro e a sincronização inteira é refeita na próxima tentativa.

### Riscos

- Se o `terminationGracePeriodSeconds` do k8s for menor que o dreno (timeout de
  10s por request + backoff de 429 podem somar dezenas de segundos), o pod é
  SIGKILLado no meio do dreno: a resposta de erro limpa desaparece — mas, do
  lado do banco, continua sem persistência parcial.
- Trabalho desperdiçado: cotas já consultadas na Aurora são descartadas quando
  a sincronização aborta.