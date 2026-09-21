# Convenções da casa

Este arquivo descreve como escrevemos código aqui. Ele é curto de propósito —
o resto se aprende lendo `src/modules/parceiros`, que é o módulo de referência.

## Fronteira com o parceiro

Dado que vem da Aurora é **não-confiável** até prova em contrário. O contrato
dela já mentiu antes e vai mentir de novo.

O caminho de um payload externo, sempre nesta ordem:

```
aurora-*.types.ts        shape CRU, exatamente como chega — nada de otimismo
aurora-*.validation.ts   valida o shape; o que não bate vira ContractViolationError
*.gateway.ts             fala HTTP, não interpreta negócio
view-models/             o que a NOSSA aplicação enxerga
```

O tipo cru **nunca** atravessa para o domínio. E nunca sai na nossa resposta.

Ver [ADR-0001](docs/adr/0001-camada-anticorrupcao.md).

## Dado fabricado

`?? 0`, `|| 0`, `as any` e `!` sobre dado externo **inventam informação**.
Um campo ausente e um campo zero são fatos diferentes; colapsar os dois já nos
custou caro.

Se o parceiro não mandou, a resposta é `undefined` e alguém acima decide.
Ver [ADR-0002](docs/adr/0002-dado-ausente-nao-e-zero.md).

## Testes

Poucos, por comportamento e por contrato. **Não perseguimos cobertura.**

Um teste bom é aquele que fica vermelho quando a realidade muda. Um teste que
assere o próprio mock não protege de nada e ainda dá a sensação de que protege —
esses a gente prefere não ter.

Nomeie pelo comportamento:

```ts
it("descarta o valor quando o parceiro manda formato inesperado", ...)
```

## Arquivos

Muitos arquivos pequenos. 200-400 linhas é o normal, 800 é o limite.
Organize por domínio, não por tipo.

## Nomes

`camelCase` para variáveis e funções, `PascalCase` para tipos, `UPPER_SNAKE`
para constantes. Booleanos com `is`/`has`/`should`/`can`.

Português nos nomes de domínio (`valorCredito`, `numeroGrupo`), inglês na
infraestrutura (`repository`, `gateway`). É inconsistente e é de propósito: o
domínio é o do negócio, que é em português.

## Commits

Conventional commits, escopo quando ajudar:

```
feat(vendas): publica evento de contrato finalizado
fix(parceiros): trata documento ausente sem fabricar string vazia
test(vendas): cobre reentrega do mesmo evento
refactor(shared): extrai tradução monetária
docs(adr): registra decisão de idempotência
chore(deps): atualiza prisma
```

Um commit por ideia. `git log --oneline` deve contar a história do PR sem que
ninguém precise abrir o diff.

## Erros

Trate explicitamente, na fronteira. Erro silencioso é pior que crash: o crash
a gente vê.

Log com contexto, sem PII. CPF, CNPJ, e-mail e telefone **não vão para o log**.

## NestJS

- Um módulo por domínio. `exports` só o que outro módulo precisa de verdade.
- Service depende de **porta** (interface + token), não de classe concreta —
  ver `ParceirosService`. É o que torna o teste possível sem subir HTTP.
- `@Global()` só para infraestrutura (Prisma, cliente do parceiro). Domínio
  nunca é global.
- `Scope.REQUEST` contamina a árvore inteira para cima. Antes de usar, saiba o
  custo.
- Nada de `forwardRef` para resolver ciclo entre módulos de domínio: ciclo ali
  é acoplamento errado, não limitação do framework.
