Rode os tres casos contra o estado atual do codigo e registre os numeros do
stub, sem alterar nada. Objetivo: evidencia reproduzivel para o PR (secao
"O que eu descobri") e para comparar antes/depois de uma mudanca.

Passos, seguindo a skill `aurora-local`:

1. Confirme containers de pe e Node 22. Suba duas instancias (3010, 3011) com o
   warmup do CI.
2. Para cada caso, nesta ordem (a mesma do CI): resetar o stub, rodar o teste,
   ler `GET /_admin/chamadas`. Guarde por caso: resultado do jest, chamadas por
   chave relevante (`lance:*`, `cota:*`, `auth:token`), `picoConcorrencia`,
   `picoTentativas`, `recusas429`, e a duracao do caso 2.
3. Conte `ERROR` e `status 401` nos logs das duas instancias.
4. Escreva um resumo em tabela (caso | esperado | observado | evidencia) e
   salve em `$ARGUMENTS` se um caminho foi passado; senao, so imprima.
5. Derrube as instancias.

Nao interprete antes de medir. Numero primeiro, hipotese depois.
