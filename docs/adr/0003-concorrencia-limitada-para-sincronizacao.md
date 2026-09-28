# ADR-0003 — Concorrencia limitada na sincronização de cotas

- **Status:** aceito
- **Data:** 2026-09-27

## Contexto

`POST /cotas-sync/:grupo` precisa do detalhe das 500 cotas de um grupo. A
Aurora:

- responde entre 200ms e 900ms por cota;
- aguanta um número limitado de requisições simultáneas — acima dele responde
  `429` com `Retry-After`;
- tem uma rota que nunca responde.

A primeira versão usava `Promise.all` sobre as 500 cotas: todas as requests
saían ao mesmo tempo, muito acima do limite do parceiro. Resultado: `429` em
massa e a sincronização caía.

O teste que vem no repositório barra a correção preguiçosa (mandar uma cota por
vez): serializando, 500 × ~500ms ≈ 250s, muito acima do teto de 60s.

## Decisión

1. **Concorrencia limitada com semáforo.** Nunca mais de `N` requests em voo,
   com `N = AURORA_CONCURRENCIA` (default 16), abaixo do limite do parceiro
   (20). É o que evita os `429` — não o retry.

2. **`429` com `Retry-After` reintenta, defensivamente.** Na produção o limite
   real pode ser partilhado entre instâncias e ser menor que 20. Se chega
   `429`, le `Retry-After`, espera e reintenta, com tope de tentativas. No teste
   não deveria nunca disparar: não conta como cota consultada — o stub só
   conta a cota quando a request passa o limite.

3. **Timeout por request.** Uma rota que nunca responde não pode segurar um
   worker para sempre. Cada request se corta com `AbortController` depois de
   `AURORA_TIMEOUT_MS` (default 10s), sem vazar o socket.

4. **Persistência todo-o-nada.** Os 500 detalhes se escreven em `createMany`
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
   cliente e **não persiste nada** — a escrita é todo-o-nada e só corre se
   as 500 completarem. Os workers esperando um slot do `LimiteGlobal`
   abortam em vez de seguir esperando. O socket do cliente não se corta no
   meio: `app.close()` só corre depois de terminada a drenagem.

6. **Renovação de token single-flight.** A sync lança 16 requests simultáneas
   em arranque a frio; sem guard, todas percebem a cache vazia e renovan ao
   mesmo tempo — manada de `POST /auth/token`, e cada renovação mata a
   anterior. `AuroraTokenProvider.renovar()` coalesce chamadas simultáneas em
   uma única. Ver Caso 3.

7. **Limite GLOBAL via Redis, JUSTO.** O semáforo local (16) limita UMA
   instância. Com oito pods, o agregado poderia chegar a 8 × 16 = 128 requests
   simultáneas contra o parceiro (limite 20). `LimiteGlobal` reserva um lease
   por request num ZSET de Redis (Lua atómico). Os slots são leases com TTL
   (`AURORA_LEASE_MS`, default = timeout + 1s): se o pod morre a meio, o slot
   se libera sozinho. Uma **cola FIFO** (ZSET por sequência) garante o reparto
   justo: quando alguém libera, se promove ao primeiro da cola — ninguén fura
   a fila. Sem isto, a re-adquisición greedy de uma instancia deixa morrer de
   fome às outras: o pico fica em 16, mas uma sola se leva todo e a outra
   estoura com "saturado". Durante a drenagem, `adquirir` aborta em vez de
   seguir esperando um slot. As esperas mortas (crash/timeout) se limpam
   sozinhas depois de `COLA_TTL_MS` (15s) — senão, após um run catastrófico, a
   cola acumularía lixo que retrasa a próxima sincronização. As chaves levam
   `REDIS_PREFIX` para que ambientes que compartam Redis não se contaminen.

8. **Token COMPARTIDO via Redis.** A Aurora mantem UM token válido por vez.
   Se cada instancia guardasse o seu, invalidaríam-se mutuamente (ping-pong de
   `401`; cada renovação mata a anterior) e a sync entre pods caía. O token
   e a sua expiração vivem em Redis: todas as instancias leem o MESMO. A
   renovação é single-flight GLOBAL (lock `SET NX PX`): só uma instancia
   renova por vez, e as outras esperam um token NOVO (nunca o que já falhou).
   Redis já estava no stack (`REDIS_URL`, ioredis), sem uso até agora.

## Consequências

- A sync de 500 cotas completa em ~17s (limite 16, ~550ms por cota) e nunca
  `429` com o limite default do stub.
- O teste do repositorio (`test/caso-2-sincronizacao.spec.ts`) passa: 500
  cotas sincronizadas, zero `429`, cada cota consultada exactamente uma vez e
  muito bajo o teto de 60s.
- Com duas instâncias sincronizando ao mesmo tempo, ambas completam em ~35s,
  o agregado fica por debaixo do limite e não há `429` (verificado em
  `test/multi-caso-2.spec.ts`).
- **Escala:** o no-`429` vale para qualquer número de instancias (agregado
  ≤ 16). O tempo de conclusão cresce sob contenção: com N syncs simultáneas,
  cada uma corre a ~16/N de concurrencia. Com oito pods serían ~138s por sync
  (o teto de 60s do teste é de UMA instancia). Comportamento correcto, não
  rápido.
- `test/multi-caso-2.spec.ts` corre local (`npm run test:caso2-multi` + `./scripts/duas-instancias.sh`); o CI do repo fica como está, com o gate de UMA instancia.
- Costo extra: manter o semáforo, o lease global (uma ida a Redis por
  request) e a transação.
- A renovação single-flight resolve a manada em UMA instância; entre
  instâncias (oito pods) cada uma renova uma vez — isso é escopo do Caso 3,
  não deste ADR.
- Test próprio em `test/caso-2-extra.spec.ts` verifica que o pico de
  concorrencia nunca chega ao limite do parceiro; `test/multi-caso-2.spec.ts`
  verifica o mesmo para o agregado de várias instancias.

## Alternativas consideradas

- **`Promise.all` com retry de 429:** não basta — o retry não evita o `429`,
  só o recupera, e em massa segue derribando o parceiro.
- **Serializar:** 250s, proibido pelo próprio teste.
- **Batch fixo de N por onda:** o timeout de uma cota pendurada segura a onda
  inteira; o semáforo + timeout individual deixa que o worker expirado se
  solte e os outros continuem.