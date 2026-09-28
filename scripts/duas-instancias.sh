#!/usr/bin/env bash
# Sobe duas instâncias da aplicação contra o mesmo banco.
#
# O Caso 1 precisa disso: uma instância só esconde metade do problema.
#
#   ./scripts/duas-instancias.sh
#   API_URLS="http://localhost:3010,http://localhost:3011" npm run test:caso1
set -euo pipefail

npx nest build

PORT=3010 node dist/main.js & PID_A=$!
PORT=3011 node dist/main.js & PID_B=$!

encerrar() { kill "$PID_A" "$PID_B" 2>/dev/null || true; }
trap encerrar EXIT INT TERM

for porta in 3010 3011; do
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 1 "http://localhost:$porta/lances/registrar" \
        -X POST -H 'content-type: application/json' \
        -d '{"grupo":"_warmup","cota":"0","assembleia":"0"}'; then
      break
    fi
    sleep 1
  done
done

echo
echo "  3010 -> pid $PID_A"
echo "  3011 -> pid $PID_B"
echo
echo "  API_URLS=\"http://localhost:3010,http://localhost:3011\" npm run test:caso1"
echo
echo "  Ctrl+C encerra as duas."
wait
