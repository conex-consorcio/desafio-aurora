# AI-LOG

Como usei IA neste desafio. É um resumo das etapas e decisões, não a
transcrição das conversas.

## Divisão de responsabilidades

- **ChatGPT** me ajudou a orquestrar o trabalho: decompor o desafio, questionar
  resultados, revisar os relatórios que o Claude Code devolvia e formular as
  etapas seguintes. Ele não teve acesso ao repositório.
- **Claude Code** foi o executor, com acesso ao repositório. Leu o código,
  alterou arquivos, rodou comandos e testes e fez as auditorias com o agente
  `race-hunter` que já vinha em `.claude/agents/`.
- **Eu** interpretei os requisitos e fiquei com a decisão final sobre cada
  mudança, a arquitetura, o escopo, os riscos e as regras de negócio.

As duas IAs propuseram e analisaram; nenhuma decidiu. Nenhuma mudança foi
aceita automaticamente só porque uma IA sugeriu. Antes de autorizar cada etapa,
revisei as alternativas, os resultados e os trade-offs. Os exemplos concretos
estão na última seção.

Ambiente: Claude Code na extensão do VS Code, no Windows. Todos os comandos do
projeto (git, npm, prisma, docker) rodaram dentro do WSL (Ubuntu 22.04).

## 1. Análise inicial, sem alterar nada

Pedido: ler README, CLAUDE.md, ADRs, `.claude/`, os testes dos três casos, o
módulo `parceiros` e o código envolvido, e checar git e ambiente. Sem
implementar, sem alterar arquivos.

O que o Claude Code trouxe:

- Problemas de ambiente:
  - o git do Windows usa `core.autocrlf=true`, então o working tree estava em
    CRLF e o git do WSL via os 52 arquivos como modificados;
  - `scripts/duas-instancias.sh` em CRLF não roda no bash;
  - o `npm` achado no WSL era o do Windows, e faltava o Node 22.
- Opções para o Caso 1 (constraint única com reserva, advisory lock, Redis,
  eleição de líder), com o que acontece em cada uma se o processo morrer.
- A recomendação do Caso 3 em vez do Caso 2, por ser uma mudança menor, local e
  testável de forma determinística.

## 2. Ambiente e baseline

O Claude Code propôs normalizar o working tree com um novo checkout.
**Recusei**: ficou só `git config --local core.autocrlf input` e a conversão de
`scripts/duas-instancias.sh` para LF.

O baseline, ainda sem nenhuma correção:

- Caso 3: 50 emissões de token para 50 requisições e 46 respostas 500.
- Caso 1, com duas instâncias: 6 e 5 chamadas de lance em vez de 8. As outras
  morreram com `aurora:registrarLance status 401`, porque as instâncias
  renovavam o token uma contra a outra (11 emissões).

O Claude Code sugeriu seguir para o Caso 1. **Inverti a ordem**: o Caso 3 veio
primeiro porque a corrida de token mascarava o baseline do Caso 1.

## 3. Caso 3: renovação de token

Pedido: uma solução local no `AuroraTokenProvider`, sem Redis, sem lock
distribuído e sem abstração genérica. Testes para renovação concorrente, para
o 401 atrasado e para falha que não pode ficar em cache.

Resultado:

- uma Promise de renovação por processo, limpa em `finally`;
- `renovar(tokenRejeitado)` reaproveita o token atual quando ele já mudou;
- o client passa para `renovar` o token que a requisição usou.

`test:caso3` ficou verde com 1 emissão e 50/50 requisições 200. Rodando o Caso
1 como diagnóstico, as 8 chamadas passaram a chegar à Aurora e a duplicação
ficou exposta por inteiro.

## 4. Caso 1: lance duplicado

A abordagem e as restrições saíram de uma decisão minha, a partir das opções
da análise:

- o Postgres coordena, com constraint única;
- uma linha de reserva com `protocolo = null` é criada antes da Aurora;
- só quem cria a reserva chama a Aurora;
- os demais esperam o protocolo com polling e prazo.

Rejeitei explicitamente Redis, advisory lock, fila, transação aberta durante o
HTTP, TTL, reconciliador e apagar a reserva em `catch`.

Pontos da execução:

- O `prisma migrate dev` não roda em ambiente não interativo. A migration saiu
  de `prisma migrate diff`.
- Autorizei apagar só as linhas locais de `lances` com duplicatas do baseline.
- O `P2002` é detectado pelo tipo do erro do Prisma e pelo `code`, nunca pelo
  texto.
- A reserva não é desfeita em erro (at-most-once), e isso é uma decisão
  consciente.
- Os testes rodam contra o Postgres real, com uma Aurora falsa que só conta
  chamadas.

Revisão antes do commit: pedi a confirmação de que o `try/catch` do `P2002`
envolve só o `create` da reserva, de que a consulta prévia do código antigo
saiu e de que nada desfaz a reserva. O teste de timeout, que espera 5s reais,
foi reconsiderado e mantido.

## 5. Auditorias com o `race-hunter`

Antes do PR, pedi ao Claude Code para rodar o `race-hunter` só sobre as
mudanças do desafio.

**Primeira auditoria.** Nenhuma corrida no código dos casos, mas dois achados
que aceitei tratar:

- Uma reserva pendente fazia `LancesService.registrar` lançar erro, e o loop
  do scheduler parava ali. Em todas as instâncias, nenhuma cota seguinte era
  registrada no mês.
- A janela T0/T1/T2 no token: um 401 atrasado de T0, chegando durante a
  renovação T1→T2, recebia T1, que já estava sendo trocado. O único retry
  falhava.

Para os erros da Aurora, decidi **não** criar uma classificação entre falha
segura e falha ambígua. Ela não existia de forma estruturada no código.

**Correções:**

- Token: `renovar` passou a aguardar primeiro uma renovação em andamento, e só
  depois a comparar o token atual com o rejeitado. Há um teste determinístico
  da janela.
- Scheduler, primeira tentativa: um `catch` por cota que logava e seguia.

**Segunda auditoria.** Os dois achados estavam resolvidos, mas o `catch` amplo
criava outro problema (R1). Com a Aurora fora, cada cota ganharia uma reserva
pendente, e o dano de uma indisponibilidade ficaria do tamanho da lista de
cotas.

**Refinamento:** uma exceção de domínio `ReservaLancePendenteError`, lançada
quando o protocolo não aparece no prazo. O scheduler pula só esse caso; qualquer
outro erro aborta a execução daquela instância, como antes. Os dois testes do
scheduler foram checados contra as versões anteriores: cada um fica vermelho
na versão que deveria pegar.

**Terceira auditoria.** Nenhum bug novo, mas o efeito distribuído apareceu. Com
N pods e a Aurora fora, cada instância pula as reservas criadas pelas
anteriores, ganha uma cota nova, falha e aborta. Isso dá até N novas reservas
pendentes por disparo do cron, e novos disparos durante a mesma
indisponibilidade podem acumular outras.

O Claude Code apresentou três opções: documentar; marcar a falha na própria
linha, o que exigiria mudar schema e migration; ou comparar timestamps.
**Decidi aceitar e documentar o limite** em vez de adicionar estado ao banco.

## Onde a decisão humana mudou o rumo

- **Novo checkout do repositório por causa de CRLF:** rejeitado.
- **Ordem dos casos:** o Caso 3 veio antes do Caso 1, contra a sugestão do
  Claude Code, porque distorcia o baseline.
- **Redis, TTL, retry automático e reconciliador:** rejeitados. No Caso 3 a
  coordenação entre pods virou resposta no PR, não código.
- **Tratamento do `P2002`:** exigi a revisão de que ele vale só para o `create`
  da reserva.
- **Scheduler:** recusei o `catch` amplo depois da segunda auditoria. Depois da
  terceira, aceitei o risco distribuído em vez de criar estado extra.
- **Caso 2:** fora, como o enunciado pede.

## Atritos de ambiente

- O PowerShell 5.1 quebrava as aspas nos comandos passados ao WSL. O Claude
  Code passou a usar o Git Bash e scripts em arquivo.
- O WSL desligou por ociosidade entre etapas e derrubou os containers. Eles
  voltaram com os dados.
- O push pelo WSL falhou por falta de chave SSH lá, e eu enviei a branch.
