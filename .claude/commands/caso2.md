---
description: Roda os testes do Caso 2 (sincronização de 500 cotas) contra a app e o stub locais e interpreta o resultado contra o contrato.
---

Roda o teste do Caso 2 e interpreta o resultado.

1. Verifica que a app está em `http://localhost:3010` e a Aurora em
   `http://localhost:4010` (healthcheck). Se não estão, diz o que falta subir
   (postgres, redis, aurora via docker compose; app via `npm start`) e para.

2. Roda `npm run test:caso2` e captura a saída completa.

3. Interpreta o resultado contra o contrato:

   | Assert | O que significa |
   |---|---|---|
   | `sincroniza as 500 cotas` | todas as cotas responderam e foram persistidas |
   | `nao leva 429 do parceiro` | nunca superamos o limite de concorrencia da Aurora |
   | `consulta cada cota exatamente uma vez` | `chamadas` tem cada cota com contador 1 |
   | `nao resolve serializando tudo` | tem paralelismo real (teto de 60s) |

4. Se algo falha, diagnostica:
   - `429` → subir a concorrencia não é a resposta; o semáforo deveria estar
     abaixo do limite. Revisa `AURORA_CONCURRENCIA`.
   - cota com contador > 1 → retry que duplicou chamada; revisa o retry de 429
     e de timeout no `AuroraClient`.
   - demora > 60s → algo serializou; revisa que `mapWithConcurrency` esteja
     realmente limitando e não esperando cada cota.

Não modifiques `test/` (os testes fornecidos são o contrato).