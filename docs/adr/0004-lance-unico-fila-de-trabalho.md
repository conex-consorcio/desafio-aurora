# ADR-0004 — Lance único com fila de trabalho e lock por cota

- **Status:** aceito
- **Data:** 2026-09-27

## Contexto

O `LancesScheduler` roda em toda instância da aplicação (oito em produção).
Dia 1 do mês, todas acordam no mesmo segundo. A Aurora **cobra por lance e não
faz idempotência**: dois lances na mesma cota são duas cobranças, e o segundo
pode invalidar o primeiro.

O problema tem duas dimensões:

1. **Efeito externo duplicado:** duas instâncias podem registrar o mesmo lance.
2. **Trabalho redundante:** todas as instâncias leem as mesmas cotas e tentam
   registrar cada uma — mesmo sem chamada duplicada, o preparativo é repetido.

## Decisão

Duas camadas, cada uma para uma dimensão:

### Camada A — efeito externo único (`LancesService.registrar`)

Arbitração **toda no Redis**, antes de tocar a Aurora:

| Camada | Mecanismo |
|---|---|
| mesma instância | single-flight (`Map<chave, Promise>`) — requests coalescem |
| entre instâncias | lock `SET lance:lock:<chave> <dono> PX 15s NX` |
| vencedor lento mas vivo | flag `lance:finishing:<chave>` (TTL 40s): um vencedor lento mas vivo não perde a posse |
| resultado | o vencedor publica `lance:resultado:<chave>` com TTL; o perdedor espera lá |
| recandidato | 1 leitura do banco, só se o Redis não tem o protocolo |

O banco fica como **registro append-only, sem índice único, sem restrições**:
não arbitra, só guarda o fato. O `INSERT` é reintentado ante erro transitório
(até 3 vezes), usando o protocolo como chave de idempotência para não duplicar
a fila se a tentativa anterior chegou a gravar.

### Endurecimento ante falhas (além da concorrência)

| Falha | Manejo |
|---|---|
| Aurora 5xx / rede / timeout | `AuroraLancesFonte` aplica timeout de 30s com `AbortController` (`TimeoutParceiroError`); o worker **reenfileira** a cota (transitório) |
| Aurora 401 (thrash de token) | transitório: outra instância renovou o token e invalidou o nosso; o cliente já reintenta uma vez e o worker reenfileira — a cota não cai em `falhadas` por um 401 |
| Aurora 4xx permanente | o worker **não** reenfileira; registra no log e a cota fica em `lances:falhadas:<mes>` para reconciliação manual |
| Reintento sem fim (retry-storm) | reenfileira com **score = tentativa** (backoff: as tentativas vão depois das frescas); ao esgotar `MAX_TENTATIVAS=3`, a cota passa a `falhadas` |
| Aurora que nunca responde | o timeout a aborta: o vencedor libera lock+finishing e falha ruidoso; a pendurada não congela o worker |
| vencedor lento (>15s) mas vivo | o flag `finishing` (40s > timeout 30s) faz o perdedor **esperar** em vez de tomar posse → sem dupla cobrança |
| INSERT falha depois de cobrar | reintento transitório; se persiste, cobrado sem registro → janela residual (abaixo) |
| SIGTERM ao worker | `onApplicationShutdown` **drena** o registro em voo (período de graça 20s); se expira, o item fica em `processando` com seu lease e o reaper o recupera |
| Redis caído | falha ruidoso, sem arbitração — aceitado, Redis é o árbitro |

### Camada B — trabalho não repetido (`LancesWorker`)

Fila de trabalho sobre sorted sets de Redis:

| Passo | Comando | Quem |
|---|---|---|
| Enfileirar | `SET lances:job:<mes> NX PX 30s`; o vencedor faz `findMany` e `ZADD lances:fila:<mes>` (em lotes de 500) | 1 instância lê o banco |
| Marcar fim do enfileiramento | `SET lances:job:<mes>:feito` | o vencedor |
| Reclamar | Lua: `ZPOPMIN fila` + `ZADD processando <now+lease>` | cada worker, atômico |
| Processar | `registrar()` (Camada A) | o que reclamou |
| Terminar | `ZREM processando` | o worker |
| Reaper | Lua: `ZRANGEBYSCORE processando -inf now` → órfãos de volta à fila | qualquer um |

O cron chama `worker.rodar(mes)`. Há guarda de duração (10 min) para que o
handler não corra para sempre. O worker **não se detém** se uma cota falha:
captura por item e decide reenfileirar (transitório) ou abandonar (permanente).

## Consequências

- Uma chamada à Aurora por cota/assembleia, com N instâncias.
- Não há instância que repita o trabalho do outro: 1 lê o banco, cada cota a
  processa 1 worker, sem reintentos redundantes.
- **Morte no meio** (a pergunta do desafio):
  - O worker que enfileira morre antes de terminar: o job lock expira (30s),
    `feito` não é setado; os workers processam os itens já enfileirados; o que
    faltou é recuperado **re-executando o cron** (`ZADD` é idempotente e o
    recandidato puxa o que já está registrado).
  - O worker morre depois do claim: o item fica em `processando`; o reaper o
    devolve à fila depois do lease; outro worker o reclama. Se o morto chegou a
    gravar no banco, o recandidato o encontra e **não chama de novo**.
  - Janela irrecuperável: morte **entre a resposta da Aurora e o `INSERT`** →
    o protocolo se perde → dupla cobrança possível. Sem idempotência do lado do
    parceiro não há como fechar essa janela.
- Distribuição entre workers não está balanceada (uma instância rápida pode
  drenar mais); a correção não depende do equilíbrio.
- Se **todas** as instâncias saem antes de que expire um lease, o órfão só
  volta na próxima re-execução do cron. Aceitado e documentado.
- O caminho de API (`POST /lances/registrar`) não se pode particionar: por isso
  a Camada A continua sendo o árbitro ali, e é a rede de recuperação do scheduler.