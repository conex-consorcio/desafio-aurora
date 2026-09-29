# AI-LOG

Log of how this challenge was driven with the help of an AI (opencode). Each
session below records what was requested and the result obtained, in the order
the work happened. The raw transcript lives in the tool's history; this file is
the honest summary.

---

## Session — 2026-09-26 — Reading the challenge and mapping requirements

### Request
Read the challenge. Map the requirements from the README, bring the PR
checklist and the house conventions (`CLAUDE.md`), and confirm the two cases:
Caso 1 (duplicate bid, mandatory) and the choice between Caso 2 and Caso 3.

### Result
- README mapped: `LancesScheduler` runs `@Cron("0 6 1 * *")` on every instance
  (eight in production); Aurora charges per bid and does not dedupe.
- Caso 1 is mandatory; between Caso 2 and Caso 3 we pick one.
- PR deliverables listed: both case tests green, our own tests, written answers
  to the two questions, honest scope, `AI-LOG.md`, tooling.
- House conventions loaded: anti-corruption layer, absent data is not zero,
  few behavior-driven tests, Portuguese in domain names.

---

## Session — 2026-09-26 — Diagnosing Caso 1 (check-then-act race)

### Request
Reproduce and explain why `test/caso-1-lance-duplicado.spec.ts` fails with two
instances against the same database. Do not propose a fix yet.

### Result
- Root cause identified as a classic check-then-act race: all instances wake at
  the same second, read the same eligible cotas, and call the Aurora; the
  database constraint protects the row, not the HTTP call already made.
- Diagnosis confirmed independently by the `race-hunter` agent.
- Two dimensions of the problem written down: duplicated external effect and
  redundant work (every instance re-reads and re-prepares each cota).

---

## Session — 2026-09-26 — Choosing between Caso 2 and Caso 3

### Request
Present the trade-off between Caso 2 (sync 500 cotas) and Caso 3 (token renewal
stampede) so I can choose.

### Result
- Caso 2 chosen. Rationale: the base problem (500 simultaneous requests against
  a limited partner) already shows with a single instance and forces you to
  deal with concurrency, timeouts, defensive retry, transactions and SIGTERM
  drain — the risks that actually show up in production.
- The token single-flight guard that Caso 2 requires also leaves Caso 3 solved
  in a single instance as a side effect; multi-instance remains Caso 3 scope.
- Not worth doing both at half quality.

---

## Session — 2026-09-26 — Caso 1 v1 (Postgres reservation + polling)

### Request
Implement a fix for the duplicate bid using a reservation row in Postgres and
polling for the outcome.

### Result
- **Discarded.** The database became the arbitrator on the hot path: the fix
  still read the bank to decide, which keeps the race window open and adds load
  to the DB on the critical path. No commit kept.

---

## Session — 2026-09-26 — Caso 1 v2 (single-flight + Redis lock)

### Request
Iterate: arbitrate in Redis instead — single-flight per instance plus a
distributed lock between instances.

### Result
- **Discarded.** Still read the database on the hot path to decide whether the
  bid already exists. The user insisted the bank should do neither constraints
  nor processing; it had to become an append-only record of the fact.

---

## Session — 2026-09-26 — Caso 1 v3 (work queue + reaper)

### Request
Iterate with the bank as append-only: build the arbitration fully in Redis with
a work queue, so only one instance reads the DB and each cota is processed by
one worker. Add a reaper for orphans.

### Result
- Delivered. Two layers:
  - **Layer A — single external effect** (`LancesService.registrar`): arbitration
    entirely in Redis before touching the Aurora — single-flight (same
    instance), `SET lance:lock:<chave> <dono> PX 15s NX` (between instances),
    `finishing` flag for slow-but-alive winners, result key the loser waits on,
    one DB read only if Redis has no protocol.
  - **Layer B — non-repeated work** (`LancesWorker`): Redis sorted-set queue —
    `ZADD lances:fila:<mes>` in batches of 500, atomic `ZPOPMIN` + `ZADD
    processando` claim, `ZREM` on finish, Lua reaper returning orphans to the
    queue after lease expiry.
- The winner sets `lances:job:<mes>` (NX, 30s) so only one instance reads the
  bank and enqueues; `feito` marks the end of enqueue.
- `test:caso1` green against two real instances
  (`./scripts/duas-instancias.sh` + `API_URLS=... npm run test:caso1`).
- ADR-0004 `docs/adr/0004-lance-unico-fila-de-trabalho.md` written.

---

## Session — 2026-09-27 — Hardening Caso 1 (crashes and failures)

### Request
"We are handling the concurrency, but are we handling crashes and failures?"
List the holes and fix all of them if I approve.

### Result
- Holes mapped: a worker that stops loses its cota; `fetch` without timeout
  hangs forever; `INSERT` without retry loses a paid bid; a slow-but-alive
  winner can be stolen.
- Approved and fixed:
  - per-cota failure tolerance (transient requeue, drop permanent 4xx);
  - 30s timeout on the Aurora call with `AbortController`
    (`TimeoutParceiroError`);
  - `INSERT` retry with protocol as idempotency key (up to 3 tries);
  - `finishing` flag so a slow-but-alive winner keeps possession.
- Requeue uses score = attempt (backoff); after `MAX_TENTATIVAS=3` the cota
  goes to `lances:falhadas:<mes>` for manual reconciliation.

---

## Session — 2026-09-27 — Caso 2 v1 (limited pool)

### Request
Implement the Caso 2 fix: sync 500 cotas without taking the partner down.

### Result
- **Discarded.** First approach was a bounded pool with retry. Retrying on
  timeout collides with "each cota queried exactly once" outside the happy
  path. The defensive 429 retry must only apply to responses that were never
  counted by the stub (the request never passed the limit). The second
  approach replaced it.

---

## Session — 2026-09-27 — Caso 2 v2 (semaphore + worker pool + token guard)

### Request
Iterate: semaphore + worker pool, per-request timeout, defensive 429 retry,
all-or-nothing write, SIGTERM drain. Add a single-flight token renewal guard
(the sync's 16 cold-start workers would stampede `/auth/token`).

### Result
- Delivered in `src/shared/concurrency/` and `src/modules/cotas-sync/`:
  - semaphore (`AURORA_CONCURRENCIA=16`, below the stub's limit of 20) — zero
    `429` by construction, not by retry;
  - per-request timeout with `AbortController` (`AURORA_TIMEOUT_MS=10000`) — a
    route that never responds does not hold a worker;
  - defensive 429 retry reading `Retry-After`, with a cap, for production;
  - `createMany` in a transaction — all-or-nothing;
  - SIGTERM ordered: `main.ts` waits for `terminar()` (drain) before
    `app.close()`; an interrupted sync throws `ConcurrencyInterruptedError`,
    persists nothing, and the `500` reaches the client;
  - `AuroraTokenProvider.renovar()` coalesces concurrent renewals (single-flight).
- Live evidence: 500-cota sync in **17s**, `201`, `recusas429=0`, each cota
  queried exactly once; SIGTERM mid-sync → `500` to client, drain logged, **0
  rows persisted** for the interrupted group vs full rows for the control
  group; cold start with 16 workers → **1 single token renewal** (before the
  guard, ~22 simultaneous renewals and `401`s).
- `npm run test:caso2` green. ADR-0003
  `docs/adr/0003-concorrencia-limitada-para-sincronizacao.md` written.

---

## Session — 2026-09-28 — Multi-instance Caso 2 (global fairness and shared token)

### Request
The local semaphore does not cover the multi-instance aggregate (8 pods × 16 =
128 concurrent, limit 20). Make the limit global and fair, and stop the token
ping-pong between instances.

### Result
- `LimiteGlobal` added: per-request leases in a Redis ZSET via atomic Lua, TTL
  `AURORA_LEASE_MS` (timeout + 1s) so a dead pod releases its slots.
- **Starvation found and fixed:** greedy re-acquisition let the first instance
  grab all 16 slots and the other wait 10s → "saturated" on both. Fix: a **fair
  FIFO queue** in Lua — the releaser promotes the first waiter, nobody cuts the
  line. Two instances now both complete in ~35s (re-checked: 37s), peak 16,
  zero `429`.
- **Token ping-pong found and fixed:** each instance cached its own token and
  they invalidated each other (~38 renewals in 10s, requests stuck on `401`).
  Fix: the token lives in Redis (everyone reads the same one) and renewal is
  **global single-flight** with `SET NX PX`; waiters receive a NEW token, never
  the one that just failed.
- Dead waits cleaned by `cola:tempo` TTL (15s); Redis cold-start race handled
  (reconnect instead of throwing on "connect"/"wait"); `REDIS_PREFIX`
  (default "aurora") namespaces keys for shared Redis environments.
- `npm run test:caso2-multi` green against two real instances; **`test:caso3`
  green as a bonus** (the shared-token guard resolves the stampede in a single
  instance).

---

## Session — 2026-09-28 — Translating lances module to Portuguese

### Request
Translate the `lances` module to Portuguese — comments, logs and identifiers
(constants, methods, fields), not only comments. Nothing Spanish in domain
names.

### Result
- `src/modules/lances/` translated end to end: comments, log messages and
  identifiers (`valorCredito`, `numeroGrupo`, `registrar`, `rodar`, constants).
- `test/` and `stub/` left untouched (they are the contract).

---

## Session — 2026-09-28 — Testing the cron and hardening 401

### Request
Exercise the real cron pipeline end to end: set the scheduler to fire every
minute, run it, then revert. Also: a 401 from the Aurora is treated as
permanent — is that right given token thrash between instances?

### Result
- Cron fired every minute and revealed a dirty database: residue from Caso 2
  runs enqueued **10,524 cotas**. Cleaned, verified clean, reverted to the
  monthly schedule (`0 6 1 * *`).
- **401 fixed as transient:** the worker was treating 401 as permanent and
  three cotas fell into `falhadas` during the cron test. Token thrash between
  instances is exactly the 401 source — now the client retries once and the
  worker requeues instead of dropping the cota.
- Full pipeline proven live against the Aurora.

---

## Session — 2026-09-29 — Verification and PR answers

### Request
Run the full verification and write the PR text: the two written answers, the
honest scope (what was left out and what was not validated), and the checklist.

### Result
- `npx tsc --noEmit` clean; `npx nest build` clean; 34 unit tests green
  (`npx jest --runInBand src`); `npm run test:caso1` green with two instances;
  `npm run test:caso2` 8/8; `npm run test:caso2-multi` 3/3 with two real
  instances.
- **Answer — Caso 1: what happens if the process dies between deciding to
  register and the Aurora's response?** The arbitration protects against
  concurrency between live instances, not against a crash in that window.
  Dying after the Aurora charged and before the `protocolo` is persisted, the
  reaper requeues and the retry charges again — a duplicated bid. The fix
  (state machine per cota with a gate that never re-calls the Aurora on a stuck
  `processing`/`error`) was documented, not implemented: it would require
  touching the repo-provided unit specs and/or a schema migration, both barred
  by the PR checklist. Residual window documented in
  `docs/analise-crash-desafio.md`.
- **Answer — Caso 2: what happens to an in-flight sync on SIGTERM?** The pod
  stops dispatching new cotas, waits for in-flight requests (each capped by its
  10s timeout), answers `500` to the client and persists nothing — the write is
  all-or-nothing and only runs if all 500 complete. Workers waiting on a
  `LimiteGlobal` slot abort instead of waiting. `app.close()` only runs after
  the drain. Risk noted: `terminationGracePeriodSeconds` shorter than
  timeout + 429 backoff → SIGKILL mid-drain (still no partial persistence).
- **Honest scope:** Caso 3 multi-instance not done (each of 8 pods would renew
  once — that is Caso 3 scope); partner-limit traffic from external consumers
  not simulated (margin kept, 16 < 20); 8-instance scale reasoned, not
  simulated (~2 concurrency each, ~138s per sync); `test:caso2-multi` not on CI
  (repo CI stays single-instance); Redis down mid-sync only covered by the
  `"end"` unit test, no integration proof.
- PR text drafted for review.