# ADR-0002 — Dado ausente não é zero

- **Status:** aceito
- **Data:** 2026-05-30

## Contexto

Um relatório de comissões mostrou R$ 0,00 para 340 parceiros durante seis dias.
Ninguém reclamou — zero é um número plausível.

A causa foi uma linha:

```ts
valorComissao: reaisToCentavos(raw.valorComissao) ?? 0
```

O parceiro tinha parado de mandar o campo. O `?? 0` transformou *"não sei"* em
*"sei, e é zero"*. Com o campo ausente teríamos visto um erro no primeiro dia.

## Decisão

Sobre dado vindo do parceiro, são proibidos:

- `?? 0` e `|| 0`
- `as any` e `as Tipo` para contornar validação
- `!` (non-null assertion)
- `Number(x) || 0`

Campo ausente vira `undefined` e sobe. Quem decide o que fazer com a ausência é
a camada de domínio, explicitamente, com o caso escrito.

Se o parceiro manda um formato que não reconhecemos, a tradução **descarta o
campo e registra warning** — nunca chuta.

## Consequências

- Mais `undefined` atravessando os tipos, e mais casos explícitos.
- Falhas aparecem cedo e ruidosas, em vez de tarde e silenciosas.
- `strict` e `noUncheckedIndexedAccess` ligados no `tsconfig` não são negociáveis.
