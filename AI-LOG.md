# AI-LOG

Como conduzi a IA neste desafio. É um registro por fases, com as decisões e
os pontos em que eu discordei ou corrigi o modelo, não a transcrição das
conversas: elas contêm material do processo seletivo (entrevista, condições)
que não pertence a um repositório público.

**Ferramenta:** Claude Code (CLI, v2.1.283), rodando local, com acesso ao
repositório, ao Docker e ao `gh`. Nenhuma outra IA. O que ficou versionado em
`.claude/` é o que foi usado: a skill `aurora-local`, o comando `/baseline` e
o agente `fronteira-auditor`, além do `race-hunter` que já vinha no repositório.

## 1. Leitura sem alterar nada (26/09)

Pedi leitura completa antes de qualquer opinião: README, `CLAUDE.md`, os dois
ADRs, `stub/server.ts`, os três testes, o CI, o template de PR, o `git log`
e o único PR aberto na época (#1). Saíram daí:

- a lista exata do que cada teste exige (ex.: o Caso 1 exige que os perdedores
  da corrida devolvam o **mesmo protocolo**, o que define a solução);
- que o CI roda `jest src` **antes** de subir o stub, logo testes próprios em
  `src/` não podem depender da Aurora;
- que o histórico do repositório tinha um timebox de 4h removido dia 25;
- três hipóteses sobre o stub para confirmar medindo: rota pendurada
  inalcançável, `valorCredito` em centavos, segunda instância subindo sem token.

## 2. Pesquisa escrita e decisões (26/09)

O modelo escreveu seis documentos de análise (contexto, anatomia do desafio,
opções do Caso 1 com "o que acontece quando o dono morre" para cada uma,
Caso 2 vs Caso 3, cenário dos PRs concorrentes, padrões de entrega) e uma
lista de 23 decisões. Eu respondi as decisões numa rodada de perguntas em
que cada opção vinha com consequência e uma recomendação justificada.

Onde a minha decisão não foi a recomendação, ou eu impus uma restrição:

- **"Nada de outro mundo."** Impus como princípio: cada mecanismo tem que ser
  explicável em uma frase e tratado como construção de software, não como
  demonstração. Isso derrubou alternativas que o modelo tinha listado
  (fila BullMQ para o Caso 1, lock em Redis, semáforo distribuído).
- **Perguntas ao Lucca.** O modelo recomendou três. Cortei a do SIGTERM: 30s
  de graça do Kubernetes é premissa boa o bastante para declarar. Fiquei com
  as duas que mudavam código (idempotência/consulta na Aurora; limite por
  integrador ou por conexão). As respostas confirmaram as duas premissas e
  estão no PR.
- **Single-flight do token.** Eu tinha decidido **não** incluir (é o Caso 3,
  que não escolhi). O baseline mostrou 11 emissões e cinco 401 no Caso 1 com
  duas instâncias, e a implicação de que o Caso 2 ficaria intermitente no CI.
  Reabri a decisão com o dado e incluí, declarado como pré-requisito, não
  como Caso 3 resolvido.

## 3. Baseline medido (26/09)

Antes de qualquer código: os três casos contra duas instâncias, com os
contadores do stub salvos. As três hipóteses da fase 1 confirmaram. Os
números estão no PR em "O que eu descobri".

## 4. Correções minhas ao modelo durante a execução

- **Identidade dos commits.** O modelo configurou o e-mail `noreply` do GitHub
  no clone, pensando em reduzir rastreabilidade. Corrigi para a minha
  identidade pessoal real e exigi verificação impressa antes do primeiro
  commit, depois dele e antes do push. Sem trailers de ferramenta nos commits.
- **Cronograma.** O modelo escreveu que "o cronograma apertou" quando faltava
  um dia. Corrigi: o gargalo não é o tempo de escrita da IA, é o meu tempo de
  revisão, porque quem faz o commit é responsável. Reorganizei a execução em
  **blocos pequenos, um commit por ideia, cada bloco revisado por mim antes
  do próximo**. Foram cinco blocos.
- **Estado `FALHOU`.** O desenho inicial tinha três estados de reserva. No
  bloco 2 o modelo propôs cair para dois (apagar a reserva quando a falha é
  certamente anterior ao envio, em vez de marcar `FALHOU` e retomar por
  compare-and-set). Aceitei porque a pergunta da morte se explica com dois
  estados e menos código. Registrado no ADR-0003.
- **Teste vermelho separado.** No Caso 1 exigi commit do teste falhando antes
  da correção. No Caso 2 aceitei o teste junto com a correção, porque ele
  dependia de API nova e não compilaria sozinho. A diferença está no
  histórico.

## 5. O que o modelo acertou e economizou tempo

- A leitura do Express: `/cotas/:grupo/:numero` registrada antes de
  `/cotas/:grupo/pendurada` torna a rota pendurada inalcançável. Confirmado
  com `curl` (200 em 0,65s).
- A relação entre a corrida de token e o baseline distorcido do Caso 1.
- A aritmética do limite (500 × ~550ms ÷ 10 ≈ 28s) antes de medir; medido:
  29–33s.
- A prova manual do SIGTERM (sinal 4s depois de iniciar um sync de 500:
  201 com 76 sincronizadas e 424 pendentes, 76 linhas no banco, processo
  encerrado 703ms depois).

## 6. Auditoria antes do PR (29/09, noite)

Rodei o `race-hunter` do repositório e o `fronteira-auditor` sobre o diff,
como subagentes, com ordem de não alterar arquivos e de provar achado com
teste executável fora do repositório.

- **`fronteira-auditor`:** dois achados, ambos tratados. O principal: a porta
  do lance prometia `{ protocolo: string }` vindo de um `as` sem guard.
- **`race-hunter`:** quatro achados com prova executável, todos tratados
  (emissão de token sem timeout; `Retry-After` sem teto; repetição continuando
  após SIGTERM; protocolo logado só depois da gravação). Duas hipóteses de
  frota (token entre instâncias; scheduler no SIGTERM): a primeira já estava
  declarada fora do escopo, a segunda eu tratei porque cabia em dez linhas.
- **Discordância que aceitei em parte:** o `race-hunter` propôs tratar
  `502/503/504` como "efeito desconhecido". Aceitei para `502` e `504` (quem
  respondeu foi um gateway; o que aconteceu atrás dele ninguém sabe) e
  mantive `503` como recusa (é o servidor dizendo que não atendeu). ADR-0003
  atualizado.

Cada achado tratado é um commit próprio, citando o auditor.

## 7. Sobre os outros PRs

Li o corpo e a lista de arquivos dos PRs #1 a #4 antes e durante o trabalho,
para saber onde estava o campo. Não abri o código de nenhum. O mecanismo do
Caso 1 (reserva no banco com unicidade) coincide com o dos PRs #1 e #3
porque é o padrão para efeito externo não idempotente; o que difere está
listado no PR.
