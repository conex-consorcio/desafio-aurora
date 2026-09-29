# ADR-0003 — Concorrência limitada na sincronização de cotas

- **Status:** aceito
- **Data:** 2026-09-27

## Contexto

`POST /cotas-sync/:grupo` precisa do detalhe das 500 cotas de um grupo. A
Aurora:

- responde entre 200ms e 900ms por cota;
- aguenta um número limitado de requisições simultâneas — acima dele responde
  `429` com `Retry-After`;
- tem uma rota que nunca responde.

A primeira versão usava `Promise.all` sobre as 500 cotas: todas as requests
saíam ao mesmo tempo, muito acima do limite do parceiro. Resultado: `429` em
massa e a sincronização caía.

O teste que vem no repositório barra a correção preguiçosa (mandar uma cota por
vez): serializando, 500 × ~500ms ≈ 250s, muito acima do teto de 60s.

## Decisão

1. **Concorrência limitada com semáforo.** Nunca mais de `N` requests em voo,
   com `N = AURORA_CONCURRENCIA` (default 16), abaixo do limite do parceiro
   (20). É o que evita os `429` — não o retry.

2. **`429` com `Retry-After` reintenta, defensivamente.** Na produção o limite
   real pode ser partilhado entre instâncias e ser menor que 20. Se chega
   `429`, lê `Retry-After`, espera e reintenta, com teto de tentativas. No teste
   não deveria nunca disparar: não conta como cota consultada — o stub só
   conta a cota quando a request passa o limite.

3. **Timeout por request.** Uma rota que nunca responde não pode segurar um
   worker para sempre. Cada request se corta com `AbortController` depois de
   `AURORA_TIMEOUT_MS` (default 10s), sem vazar o socket.

4. **Persistência todo-ou-nada.** Os 500 detalhes se escrevem em `createMany`
   dentro de uma transação. A sincronização interrompida não persiste estado
   parcial.

5. **SIGTERM ordenado.** `main.ts` espera `CotasSyncService.terminar()` antes
   de `app.close()`. `terminar()` marca a drenagem (não se despacham mais
   cotas), espera o que está em voo (limitado pelo timeout) e devolve. A sync
   interrompida lança `ConcurrencyInterruptedError` — erro explícito, nunca
   silencioso.

   **Resposta à pergunta do enunciado.** Com SIGTERM a meio de uma
   sincronização: o pod deixa de despachar cotas novas, espera as requests
   em voo (cada uma cortada pelo seu timeout de 10s), responde `500` ao
   cliente e **não persiste nada** — a escrita é todo-ou-nada e só corre se
   as 500 completarem. Os workers esperando um slot do `LimiteGlobal`
   abortam em vez de seguir esperando. O socket do cliente não se corta no
   meio: `app.close()` só corre depois de terminada a drenagem.

6. **Renovação de token single-flight.** A sync lança 16 requests simultâneas
   em arranque a frio; sem guard, todas percebem a cache vazia e renovam ao
   mesmo tempo — manada de `POST /auth/token`, e cada renovação mata a
   anterior. `AuroraTokenProvider.renovar()` coalesce chamadas simultâneas em
   uma única. Ver Caso 3.

7. **Limite GLOBAL via Redis, JUSTO.** O semáforo local (16) limita UMA
   instância. Com oito pods, o agregado poderia chegar a 8 × 16 = 128 requests
   simultâneas contra o parceiro (limite 20). `LimiteGlobal` reserva um lease
   por request num ZSET de Redis (Lua atômico). Os slots são leases com TTL
   (`AURORA_LEASE_MS`, default = timeout + 1s): se o pod morre a meio, o slot
   se libera sozinho. Uma **fila FIFO** (ZSET por sequência) garante a
   distribuição justa: quando alguém libera, se promove ao primeiro da fila —
   ninguém fura a fila. Sem isto, a re-aquisição greedy de uma instância deixa
   morrer de fome as outras: o pico fica em 16, mas uma só leva tudo e a outra
   estoura com "saturado". Durante a drenagem, `adquirir` aborta em vez de
   seguir esperando um slot. As esperas mortas (crash/timeout) se limpam
   sozinhas depois de `COLA_TTL_MS` (15s) — senão, após um run catastrófico, a
   fila acumularia lixo que atrasa a próxima sincronização. As chaves levam
   `REDIS_PREFIX` para que ambientes que compartam Redis não se contaminem.

8. **Token COMPARTIDO via Redis.** A Aurora mantém UM token válido por vez.
   Se cada instância guardasse o seu, invalidariam-se mutuamente (ping-pong de
   `401`; cada renovação mata a anterior) e a sync entre pods caía. O token
   e a sua expiração vivem em Redis: todas as instâncias leem o MESMO. A
   renovação é single-flight GLOBAL (lock `SET NX PX`): só uma instância
   renova por vez, e as outras esperam um token NOVO (nunca o que já falhou).
   Redis já estava no stack (`REDIS_URL`, ioredis), sem uso até agora.

## Consequências

- A sync de 500 cotas completa em ~17s (limite 16, ~550ms por cota) e nunca
  `429` com o limite default do stub.
- O teste do repositório (`test/caso-2-sincronizacao.spec.ts`) passa: 500
  cotas sincronizadas, zero `429`, cada cota consultada exatamente uma vez e
  muito abaixo do teto de 60s.
- Com duas instâncias sincronizando ao mesmo tempo, ambas completam em ~37s,
  o agregado fica por debaixo do limite e não há `429` (verificado em
  `test/multi-caso-2.spec.ts`).
- **Escala:** o no-`429` vale para qualquer número de instâncias (agregado
  ≤ 16). O tempo de conclusão cresce sob contenção: com N syncs simultâneas,
  cada uma corre a ~16/N de concorrência. Com oito pods seriam ~138s por sync
  (o teto de 60s do teste é de UMA instância). Comportamento correto, não
  rápido.
- `test/multi-caso-2.spec.ts` corre local (`npm run test:caso2-multi` + `./scripts/duas-instancias.sh`); o CI do repo fica como está, com o gate de UMA instância.
- Custo extra: manter o semáforo, o lease global (uma ida a Redis por
  request) e a transação.
- A renovação single-flight resolve a manada em UMA instância; entre
  instâncias (oito pods) cada uma renova uma vez — isso é escopo do Caso 3,
  não deste ADR.
- Test próprio em `test/caso-2-extra.spec.ts` verifica que o pico de
  concorrência nunca chega ao limite do parceiro; `test/multi-caso-2.spec.ts`
  verifica o mesmo para o agregado de várias instâncias.

## Alternativas consideradas

- **`Promise.all` com retry de 429:** não basta — o retry não evita o `429`,
  só o recupera, e em massa segue derrubando o parceiro.
- **Serializar:** 250s, proibido pelo próprio teste.
- **Batch fixo de N por onda:** o timeout de uma cota pendurada segura a onda
  inteira; o semáforo + timeout individual deixa que o worker expirado se
  solte e os outros continuem.