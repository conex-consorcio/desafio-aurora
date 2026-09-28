# AI-LOG — Caso 2 (sincronização de 500 cotas)

Registro de como se conduziu o modelo nesta sessão. Ferramenta usada:
opencode (Claude Code como referência, não usado nesta branch).

## Objetivo

Resolver o Caso 2 (obrigatório na escolha 2/3) e deixar os entregáveis do PR:
testes próprios, ADR, respostas às perguntas, escopo honesto, `AI-LOG.md` e
ferramental.

## Decisión de desenho (resumo)

1. **Semáforo + worker pool** (`src/shared/concurrency/`) com
   `AURORA_CONCURRENCIA=16` (default), por debaixo do limite de 20 do stub →
   zero `429` por construção.
2. **Timeout por request** com `AbortController` em `AuroraClient`
   (`AURORA_TIMEOUT_MS=10000`) → a rota que nunca responde não segura um
   worker.
3. **Retry defensivo de 429** lendo `Retry-After`, com tope → para produção
   onde o limite real é compartilhado entre instancias.
4. **`createMany` em transação** → todo-o-nada.
5. **SIGTERM ordenado**: `main.ts` espera `terminar()` (drenagem) antes de
   `app.close()`. A sync interrompida lança `ConcurrencyInterruptedError`,
   não persiste nada, e o `500` chega ao cliente (NestJS por padrão corta os
   sockets activos ao fechar; esperamos a drenagem antes de fechar).
6. **Renovação de token single-flight** em `AuroraTokenProvider` → evita a
   manada de `/auth/token` que a concorrencia da sync expone no arranque a
   frio. Efecto colateral: também resolve o Caso 3 em uma instancia.

## Evidencia obtida ao vivo

- Sync de 500 cotas: **17s**, `201`, `recusas429=0`, cada cota consultada 1
  vez (testes provistos + próprio em `test/caso-2-extra.spec.ts`).
- SIGTERM a meio de sync: resposta `500` ao cliente, log de drenagem, **0
  filas persistidas** para o grupo interrompido (verificado na BD) vs filas
  completas para o grupo de control.
- Arranque a frio com 16 workers: **1 sola renovação de token** (antes do
  guard, ~22 renovações simultáneas e `401`).
- `npm run test:caso2` e `npm run test:caso3` verdes.

## Comandos chave

```bash
npm run test:caso2        # contrato do caso 2 (provistos + extra)
npm run test:caso3        # verde pelo guard de token (bônus)
npx jest --runInBand src  # unit tests
npx tsc --noEmit
```

## Achados (para o PR)

- O `warmup` do CI (`curl -XPOST /lances/registrar` com o mesmo body) faz
  *short-circuit* na BD se o lance já existe: **não renova o token**. Com a
  BD recém-sembrada renova; com lances previos, não. Isto mascarou uma
  estampida de token durante as provas manuais.
- O `429` retry do `AuroraClient` é seguro para o exactly-once: o stub só
  conta a cota quando a request passa o limite.
- **O semáforo local não cubre o agregado multi-instancia.** O enunciado diz
  que a app corre em vários serviços; 8 pods × 16 workers = 128 concurrentes,
  muito por cima do limite (20). Agregamos `LimiteGlobal` (leases em Redis
  via Lua), e `test/multi-caso-2.spec.ts` o demostra com duas instancias
  reais (`./scripts/duas-instancias.sh`). Redis já estava no stack
  (`REDIS_URL`, ioredis) mas ningún código o usava.
- **A adquisición greedy morre de fome entre instancias.** Com o lease por
  request e re-adquisición instantánea, a primeira instancia se leva os 16
  slots e a outra espera 10s → "saturado" em ambas. Fix: **cola FIFO justa**
  no Lua de `LimiteGlobal` — quem libera promove ao primeiro da cola, ninguén
  fura a fila. Com duas instancias ambas completan em ~35s (re-verificado:
  37s), pico 16, zero 429.
- **Ping-pong de token entre instancias.** Cada instancia cacheaba o seu
  token e se invalidavam mutuamente (~38 renovações em 10s, requests
  penduradas em 401). Fix: o token vive em Redis (todas leem o MESMO) e a
  renovação é single-flight GLOBAL com lock `SET NX PX`; os que esperan
  recebem um token NOVO, nunca o que já falhou (um token velho pode seguir
  "válido" na cache mas já não ser aceito pelo socio). Efecto: `test:caso3`
  verde.
- **Cola com esperas mortas.** Um worker que agota a sua espera ("saturado")
  deixa a sua entrada na cola FIFO; tras um run catastrófico a cola
  acumularía lixo que retrasa a seguinte sync. Fix: `cola:tempo` com TTL
  (15s) — o acquire/release Lua limpa as esperas mortas.
- **Race de arranque de Redis.** `redis.status` em "connect"/"wait" já não
  estoura: reintenta no poll. Só "close"/"end" (Redis realmente caído) lança
  erro ruidoso.
- **`REDIS_PREFIX`** (default "aurora") nas chaves (`aurora:token`,
  `aurora:limite:*`) para que ambientes que compartan um mesmo Redis não se
  contaminen.

## Desacuerdos com o modelo / correções

1. **Campo de instrumentação**: o stub e o test usan `picoConcorrencia`
   (portugués), não `picoConcurrencia`. O primeiro esbozo do test extra usaba
   o nome espanhol e falhou o matcher — corrigido lendo o stub real.
2. **Escopo do token provider**: inicialmente se decidiu NÃO tocar o token
   (era "territorio do Caso 3"). Ao provar o SIGTERM a frio apareceu a manada
   de renovações rompendo a sync. Se revisou a decisión: o guard single-flight
   protege diretamente o objetivo do Caso 2 ("não derribar o parceiro") e se
   implementou, documentando o limite (entre instancias segue sendo escopo do
   Caso 3).
3. **`app.close()` corta sockets activos**: a primeira versão do shutdown
   chamaba `app.close()` directo e o `500` se perdia (conexión cortada). Se
   agregou `terminar()` que drena antes de fechar — verificado com resposta
   `500` chegando ao cliente.
4. **Procesos zombie**: `pkill -f "node dist/main.js"` se mataba a sí mesmo
   (o padrón coincide com a própria linha de comando). Usamos `[n]ode` como
   truco para evitar o self-match.

## Respostas para o PR

**Por que o Caso 2 e não o Caso 3.** Entre o 2 e o 3 faço o 2. O problema de
base — sincronizar 500 cotas sem derrubar o parceiro — já se manifesta com
uma única instancia (`Promise.all` sobre 500 cotas → manada de requests, o
stub responde `429` em massa), e para resolvé-lo há que tratar concorrencia,
timeouts, retry defensivo, transação e drenagem por SIGTERM: os riscos que
mais se veem em produção. O guard de token single-flight que o Caso 2 exige
pela sua própria causa (16 workers em arranque a frio → manada de
`/auth/token`) deixa o Caso 3 resolto em UMA instancia de brinde, e o resto
do Caso 3 (multi-instancia) é escopo do outro caso. Não valia a pena fazer
os dois com metade da qualidade.

**O que acontece com uma sincronização em andamento quando o pod recebe
SIGTERM?** O pod deixa de despachar cotas novas, espera as requests em voo
(cada uma limitada pelo seu timeout de 10s), responde `500` ao cliente e
**não persiste nada**: a escrita é todo-o-nada, só corre se as 500
completarem. Os workers esperando um slot do `LimiteGlobal` abortam em vez
de seguir esperando. O socket do cliente não se corta no meio — `app.close()`
só corre depois de terminada a drenagem. Verificado ao vivo: `500` chegando
ao cliente e 0 filas persistidas na BD para o grupo interrompido.

## O que ficou fora

- **Caso 1** (lance duplicado): obrigatório para o PR, não abordado nesta
  sessão.
- **Caso 3 multi-instancia**: o guard single-flight resolve a manada em uma
  instancia; oito pods renovan cada um uma vez (escopo do Caso 3).
- **Limite do socio fora do nosso tráfico**: o `LimiteGlobal` presuposta as
  requests do sync (e de paso o tráfico de lances, que é secuencial e não
  rompe o limite). O limite do socio também se comparte com consumidores
  externos que não controlamos — deixamos margen (16 < 20). O tráfico de
  `/grupos/:numero` e `/auth/token` não passa pelo limite de concorrencia do
  stub.
- **Escala a 8 instancias**: com 8 syncs simultáneas o no-429 se mantén, mas
  cada uma corre a ~2 de concorrencia (~138s por sync). Não simulado; o teto
  de 60s do test é de UMA instancia.
- **`test/multi-caso-2` não corre em CI** (decisión: o CI do repo fica como
  está, gate de uma instancia). Corre local com `./scripts/duas-instancias.sh`.
- **Redis caído a meio de sync** (falha ruidosa, não silenciosa) — coberto
  por unit test do estado "end".

### O que NÃO validé

- SIGTERM só o prové manualmente, local, com uma sync de 500 real; não o
  prové com requests penduradas nem em CI.
- Escala a 8 instancias: só raciocinio (agregado ≤ 16 → no-`429`); não há
  simulação nem teste com 8 pods.
- Redis caído a meio de sync real: só coberto por unit test do estado
  `"end"`; não há prova de integração da drenagem com Redis caído.
- Tráfico externo compartindo o limite do socio: fora do nosso control, não
  simulado; deixamos margen (16 < 20).

## Nota — sessão de documentação

Esta documentação (ADR-0003, `AI-LOG.md`, ferramental `.claude`) foi
normalizada de espanhol a portugués nesta sessão, e re-verificada antes de
dar por boa: `tsc --noEmit` limpo, 34 unit tests verdes, `npm run test:caso2`
8/8 e `npm run test:caso2-multi` 3/3 com duas instancias reais.