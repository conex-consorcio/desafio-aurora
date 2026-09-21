# ADR-0001 — Camada anticorrupção na fronteira com o parceiro

- **Status:** aceito
- **Data:** 2026-04-18

## Contexto

A Aurora é a fonte dos nossos dados de venda e não é nossa. O contrato dela
muda sem aviso, e mais de uma vez o que estava documentado não era o que
chegava na resposta.

Na primeira versão da integração o payload do parceiro atravessava a aplicação
inteira: o objeto que saía do `fetch` era o mesmo que chegava no controller e
o mesmo que saía na nossa resposta HTTP. Quando a Aurora renomeou um campo,
tivemos que tocar 23 arquivos e dois consumidores quebraram em produção antes
de alguém perceber.

## Decisão

Todo dado externo passa por quatro estágios, nesta ordem:

| Estágio | Arquivo | Responsabilidade |
|---|---|---|
| Cru | `aurora-*.types.ts` | o shape exatamente como chega, com tudo opcional onde não temos garantia |
| Validação | `aurora-*.validation.ts` | confere o shape; o que não bate vira `ContractViolationError` |
| Transporte | `*.gateway.ts` | fala HTTP; não interpreta negócio |
| Domínio | `view-models/` | o que a nossa aplicação enxerga |

O tipo cru **não atravessa** para o domínio, e **não aparece** na resposta da
nossa API. A tradução é o único lugar que sabe o formato do parceiro.

## Consequências

- Mudança de contrato do parceiro fica contida em dois arquivos.
- Escrever integração custa mais código no começo.
- Ganhamos um lugar óbvio para registrar cada divergência observada.
