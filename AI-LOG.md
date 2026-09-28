# AI-LOG

Registro de como utilizei IA durante o desenvolvimento do Desafio Aurora.

Este documento resume as principais interações, decisões, validações e mudanças realizadas com apoio de IA. Não é uma transcrição integral das conversas, mas mantém a sequência real do trabalho e os pontos que influenciaram a implementação.

## Divisão de responsabilidades

* **Eu** fui responsável pela interpretação do enunciado, decisões de arquitetura, validação das sugestões, implementação final e definição do que seria aceito ou alterado.
* **Claude Code** foi utilizado com acesso ao repositório para analisar o código, investigar os testes, revisar implementações, sugerir soluções e validar os cenários executando os testes.
* **ChatGPT** foi utilizado como apoio para organizar o raciocínio, revisar abordagens, questionar decisões técnicas, analisar resultados apresentados pelo Claude Code e auxiliar na documentação e comunicação das decisões.

Nenhuma alteração foi aceita automaticamente apenas por ter sido sugerida por uma IA. As propostas foram analisadas e validadas antes de serem incorporadas ao projeto.

---

## 1. Análise inicial do Caso 1

O primeiro problema identificado foi a duplicação de lances quando duas instâncias da aplicação executavam a mesma operação simultaneamente.

O teste inicial apresentou:

```text
FAIL test/caso-1-lance-duplicado.spec.ts

Expected: 1
Received: 3

Expected: 1
Received: 8
```

Minha análise inicial para o Claude Code foi que duas instâncias poderiam receber o mesmo cliente/cota e executar o registro simultaneamente, sem que uma instância soubesse que a outra já havia iniciado ou concluído a operação.

Também apresentei uma proposta arquitetural diferente de adicionar uma coluna de controle em cada tabela que precisasse de idempotência, levei em consideração a resolução do caso de maneira eficaz, criar uma tabela centralizada e reutilizável para controlar operações idempotentes, solucionando o problema em qualquer local da aplicação.

A estrutura proposta foi:

```prisma
model ChaveIdempotencia {
  id        String   @id @default(uuid())
  chave     String   @unique
  status    String   @default("PENDENTE")
  resultado Json?
  erro      String?
  criadoEm  DateTime @default(now())

  @@map("chaves_idempotencia")
}

model Lance {
  id         String   @id @default(uuid())
  grupo      String
  cota       String
  assembleia String
  protocolo  String
  criadoEm   DateTime @default(now())

  @@unique([grupo, cota, assembleia])
}
```

### Feedback do Claude Code

O Claude Code validou a ideia central da tabela de idempotência e destacou que a constraint `UNIQUE` no Postgres permitiria coordenar diferentes instâncias da aplicação utilizando o mesmo banco.

Por outro lado, identificou um problema no primeiro código enviado: o decorator procurava uma propriedade chamada `idempotencia`, enquanto o serviço havia sido injetado com o nome `_`.

A implementação utilizava:

```ts
constructor(
  private readonly _: IdempotenciaService,
  ...
)
```

enquanto o decorator procurava:

```ts
this.idempotencia
```

O Claude Code apontou que isso faria o decorator falhar antes de executar a lógica de idempotência.

### Decisão

Corrigi o wiring do serviço para que o decorator tivesse acesso à instância correta de `IdempotenciaService`.

Depois da correção, o Caso 1 passou nos cenários existentes:

```text
PASS test/caso-1-lance-duplicado.spec.ts

√ registra o lance no parceiro uma unica vez sob concorrencia
√ devolve o mesmo protocolo para todos os chamadores
√ nao registra novamente um lance ja persistido
√ permite registrar lances de cotas diferentes independentemente
√ permite registrar o mesmo lance em assembleias diferentes

Tests: 5 passed, 5 total
```

A solução passou a utilizar uma tabela centralizada de idempotência, com uma chave determinística para a operação:

```text
lance:{grupo}:{cota}:{assembleia}
```

A operação vencedora cria a chave utilizando a constraint única. As demais requisições identificam que a operação já está em andamento e aguardam o resultado persistido.

---

## 2. Análise do Caso 2

Depois de validar o Caso 1, analisei o problema de sincronização das 500 cotas.

O comportamento descrito no enunciado indicava que realizar as 500 chamadas simultaneamente ultrapassaria a capacidade da Aurora e provocaria respostas `429`.

O Claude Code analisou o fluxo existente e identificou o problema como ausência de controle de concorrência:

* as 500 tarefas eram disparadas sem um limite adequado;
* a Aurora recusava requisições acima do limite;
* a primeira falha fazia o `Promise.all` rejeitar;
* as cotas aceitas não completavam a sincronização esperada.

### Abordagem escolhida

Foi criada uma função genérica para processar uma coleção com um número limitado de workers:

```ts
export async function mapComLimite<T, R>(
  itens: readonly T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(itens.length);
  let proximo = 0;
  let abortado = false;

  async function trabalhador(): Promise<void> {
    while (!abortado) {
      const indice = proximo++;

      if (indice >= itens.length) {
        return;
      }

      try {
        resultados[indice] = await fn(itens[indice]!, indice);
      } catch (erro) {
        abortado = true;
        throw erro;
      }
    }
  }

  const trabalhadores = Math.max(
    1,
    Math.min(limite, itens.length),
  );

  await Promise.all(
    Array.from({ length: trabalhadores }, trabalhador),
  );

  return resultados;
}
```

O serviço passou a utilizar uma quantidade configurável de concorrência:

```ts
const CONCORRENCIA = Number(
  process.env.AURORA_CONCORRENCIA ?? 8,
);
```

Em vez de disparar as 500 requisições simultaneamente, o processamento passou a manter um pool limitado de workers.

### Validação inicial

Os quatro testes fornecidos pelo desafio passaram:

```text
PASS test/caso-2-sincronizacao.spec.ts

√ sincroniza as 500 cotas
√ nao leva 429 do parceiro
√ consulta cada cota exatamente uma vez
√ nao resolve serializando tudo

Tests: 4 passed, 4 total
```

O quarto teste foi especialmente importante porque confirmou que a solução não havia simplesmente serializado todas as chamadas.

### Testes adicionais

Além dos testes fornecidos, adicionei dois cenários:

```text
√ nao ultrapassa o limite de concorrencia da Aurora
√ sincroniza corretamente uma quantidade menor que o pool de workers
```

Resultado:

```text
PASS test/caso-2-sincronizacao.spec.ts

√ sincroniza as 500 cotas
√ nao leva 429 do parceiro
√ consulta cada cota exatamente uma vez
√ nao resolve serializando tudo
√ nao ultrapassa o limite de concorrencia da Aurora
√ sincroniza corretamente uma quantidade menor que o pool de workers

Tests: 6 passed, 6 total
```

O primeiro teste adicional valida diretamente o limite de concorrência, enquanto o segundo cobre o comportamento do `mapComLimite` quando a quantidade de itens é menor que a quantidade configurada de workers.

### Limitações identificadas

Durante a revisão, o Claude Code apontou que o enunciado também menciona:

* uma rota da Aurora que pode nunca responder;
* `Retry-After` em respostas `429`;
* comportamento durante `SIGTERM`.

Esses pontos não foram implementados nessa abordagem.

A resposta específica sobre `SIGTERM` deverá considerar que o estado da sincronização é mantido em memória durante a execução. Se o pod for encerrado no meio da sincronização, as requisições em andamento são interrompidas e o estado não concluído não possui, nessa implementação, um mecanismo distribuído de retomada.

---

## 3. Análise do Caso 3

Também implementei e validei o Caso 3 para analisar a renovação concorrente de token.

O problema inicial apresentado pelo teste foi:

```text
Expected: 1
Received: 50
```

Além disso, diversas requisições terminavam com `500`.

A causa identificada foi que várias requisições percebiam o token expirado ao mesmo tempo e chamavam `renovar()` independentemente.

Como a Aurora mantém somente um token válido, cada nova emissão invalidava o token emitido anteriormente.

### Abordagem proposta

A solução implementada no `AuroraTokenProvider` passou a manter uma Promise compartilhada para uma renovação em andamento:

```ts
private renovacaoEmAndamento: Promise<string> | null = null;
```

A lógica passou a ser:

1. verificar se já existe uma renovação em andamento;
2. caso exista, reutilizar a mesma Promise;
3. caso não exista, iniciar uma única emissão;
4. limpar a Promise no `finally`.

Trecho principal:

```ts
async renovar(): Promise<string> {
  if (this.renovacaoEmAndamento) {
    return this.renovacaoEmAndamento;
  }

  this.renovacaoEmAndamento = this.emitirToken();

  try {
    return await this.renovacaoEmAndamento;
  } finally {
    this.renovacaoEmAndamento = null;
  }
}
```

A ideia é conhecida como *single-flight*: várias requisições concorrentes aguardam a mesma operação de renovação em vez de dispararem novas emissões.

---

## 4. Testes adicionais do Caso 3

Além do teste original, foram adicionados cenários para verificar o comportamento em situações diferentes.

Foram cobertos:

* uma única renovação para 50 requisições concorrentes;
* reutilização do token enquanto ele continua válido;
* renovação após expiração;
* concorrência menor;
* uma segunda onda de requisições após uma nova expiração.

Resultado:

```text
PASS test/caso-3-token.spec.ts

√ renova o token uma unica vez
√ nenhuma requisicao morre por token invalido
√ reutiliza o token enquanto ele ainda estiver valido
√ renova novamente quando o token expira
√ mantem uma unica renovacao com concorrencia menor
√ faz uma nova renovacao em uma segunda onda apos nova expiracao

Tests: 6 passed, 6 total
```

O cenário de 50 requisições concorrentes passou com apenas uma renovação de token.

---

## 5. Decisão sobre o escopo

O desafio determina que o Caso 1 é obrigatório e que, entre os Casos 2 e 3, um deles deve ser escolhido.

Durante o desenvolvimento, utilizei os três casos como parte da investigação e validação técnica. O Caso 1 foi tratado como obrigatório e os Casos 2 e 3 foram implementados e testados durante o processo.

A decisão de escopo da entrega final deve respeitar a regra do enunciado: a realização dos dois casos opcionais não representa pontuação adicional em relação à execução de um deles com qualidade.

---

## 6. Decisões tomadas durante o uso de IA

Algumas decisões importantes partiram de questionamentos próprios e foram posteriormente validadas com a IA.

### Idempotência centralizada

Optei por uma tabela centralizada de idempotência em vez de adicionar campos específicos de controle em cada entidade que necessitasse desse comportamento.

A intenção foi deixar o mecanismo reutilizável para outras operações além de `Lance`.

### Concorrência no Caso 2

Optei por um pool limitado de workers em vez de:

* disparar as 500 chamadas simultaneamente;
* processar tudo de forma serial;
* depender apenas do `Promise.all`.

A solução precisava respeitar a capacidade do parceiro sem perder o paralelismo exigido pelo teste.

### Renovação de token

No Caso 3, optei por coordenar as renovações dentro do processo utilizando uma Promise compartilhada.

Essa solução resolve a concorrência entre requisições da mesma instância.

Ela não representa, porém, uma coordenação global entre oito instâncias da aplicação.

---

## 7. Limitação distribuída do Caso 3

O enunciado pergunta o que aconteceria com oito instâncias quando o token expirasse.

A implementação atual do *single-flight* mantém seu estado em memória. Portanto, a coordenação acontece por processo, não globalmente.

Com oito instâncias, cada processo pode perceber a expiração e iniciar sua própria renovação. Como a Aurora mantém apenas um token válido globalmente, uma renovação em uma instância pode invalidar o token utilizado por outra.

Portanto, a solução atual resolve a corrida entre requisições dentro de uma mesma instância, mas não resolve a coordenação distribuída entre todas as instâncias.

Uma solução distribuída exigiria compartilhar o estado do token e coordenar a renovação entre os processos, por exemplo utilizando um mecanismo de lock distribuído.

Essa parte foi mantida como uma limitação arquitetural identificada, e não como uma mudança adicional no escopo local do caso.

---

## 8. O que foi validado

Durante o desenvolvimento foram executados e validados:

* Caso 1 com concorrência;
* reutilização do resultado idempotente;
* operações idempotentes para diferentes cotas;
* operações idempotentes para diferentes assembleias;
* Caso 2 com 500 cotas;
* limite de concorrência com a Aurora;
* quantidade de itens menor que o pool de workers;
* Caso 3 com 50 requisições concorrentes;
* reutilização de token válido;
* nova renovação após expiração;
* segunda onda de renovação após nova expiração.

Os testes fornecidos pelo desafio utilizados nos casos implementados ficaram verdes.

---

## 9. O que não foi validado

Não foram implementados ou validados de forma completa:

* retomada de uma sincronização do Caso 2 após `SIGTERM`;
* retomada distribuída de uma sincronização interrompida;
* uma política completa de tratamento de `Retry-After`;
* uma rota que permaneça indefinidamente pendente no Caso 2;
* coordenação global da renovação de token entre oito instâncias;
* lock distribuído para renovação de token.

Esses pontos foram identificados durante a análise, mas não foram incorporados à solução apresentada.

---

## 10. Conclusão

A IA foi utilizada como ferramenta de análise, implementação assistida, investigação de falhas e revisão dos cenários.

O processo não consistiu em simplesmente solicitar uma solução pronta. A implementação foi construída de forma iterativa:

1. reproduzir o problema;
2. apresentar a hipótese e a abordagem;
3. discutir a solução com a IA;
4. implementar;
5. executar os testes;
6. analisar as falhas;
7. adicionar cenários próprios;
8. revisar as limitações;
9. decidir o que entraria ou não no escopo.

As decisões finais de arquitetura, escopo e aceitação das soluções foram minhas.

---

# 11. Trechos das conversas

Abaixo estão trechos reais das interações utilizadas durante o desenvolvimento. Eles foram mantidos para demonstrar como as decisões foram sendo construídas, questionadas e validadas ao longo do desafio.

## 11.1 Caso 1 — Identificação da concorrência

### Eu

> Olá Claude, nesse momento trabalharemos em um novo desafio

O primeiro teste apresentou:

```text
FAIL  test/caso-1-lance-duplicado.spec.ts
  Caso 1 - registro concorrente de lance
    × registra o lance no parceiro uma unica vez sob concorrencia
    × devolve o mesmo protocolo para todos os chamadores

Expected: 1
Received: 3

Expected: 1
Received: 8
```

Minha análise inicial foi que duas instâncias acabavam realizando dois registros para o mesmo registro.

> Ou seja, se eu enviar na instância 1 o mesmo cliente e cota e abrir outra instancia e fizer o mesmo, ele não identifica.

Também apresentei a ideia de utilizar uma tabela centralizada de idempotência, evitando acoplar uma coluna de status a cada tabela que necessitasse desse comportamento.

### Claude Code

> A ideia central está certa e é melhor que as duas alternativas que você mesmo descartou: uma tabela genérica com `chave UNIQUE` resolve o "check-then-act" porque a garantia de exclusividade vira uma constraint atômica do Postgres — funciona entre instâncias diferentes, não só dentro de um processo.

O Claude Code também encontrou um problema no primeiro código:

> O decorator `@Idempotente` procura `this.idempotencia`, mas o serviço foi injetado como `_`.

### Eu

> Perfeito, te enviei o anterior sem contemplar a correção, mas realizei a correção e está contemplado o sucesso na execução.

Resultado:

```text
PASS test/caso-1-lance-duplicado.spec.ts

√ registra o lance no parceiro uma unica vez sob concorrencia
√ devolve o mesmo protocolo para todos os chamadores
√ nao registra novamente um lance ja persistido
√ permite registrar lances de cotas diferentes independentemente
√ permite registrar o mesmo lance em assembleias diferentes

Tests: 5 passed, 5 total
```

---

## 11.2 Caso 2 — Controle de concorrência

### Eu

> Neste 2° caso temos a proposta em resumo dispara as 500 chamadas ao mesmo tempo. A Aurora só aguenta N simultâneas...

Também apresentei a implementação de `mapComLimite` para processar as chamadas utilizando um número limitado de workers.

### Claude Code

> A solução atende ao teste e o desenho está certo: pool de N workers com índice compartilhado (seguro, porque o JS é single-thread), sem serializar e sem estourar o limite.

O Claude Code também identificou limitações que não estavam cobertas pela implementação:

> Mas o enunciado tem três pontos que os testes não cobrem e que a solução ainda não trata: a rota que nunca responde, o `Retry-After` e o SIGTERM.

### Eu

> Perfeito Claude adicionei mais 2 cenários

Resultado:

```text
PASS test/caso-2-sincronizacao.spec.ts

√ sincroniza as 500 cotas
√ nao leva 429 do parceiro
√ consulta cada cota exatamente uma vez
√ nao resolve serializando tudo
√ nao ultrapassa o limite de concorrencia da Aurora
√ sincroniza corretamente uma quantidade menor que o pool de workers

Tests: 6 passed, 6 total
```

### Claude Code

> Bom, os dois cenários novos fecham buracos reais: um prova que o pico de chamadas simultâneas realmente fica dentro do limite, e o outro cobre a borda `total < concorrência` no `mapComLimite`.

---

## 11.3 Caso 3 — Renovação concorrente de token

### Eu

> Perfeito Claude, esse agora é o terceiro caso onde temos uma renovação de token sendo realizada a todo momento invalidando o token anterior e gerando um novo token dentro de diferentes chamadas.

O problema inicial apresentava:

```text
Expected: 1
Received: 50
```

e diversas respostas `500`.

### Claude Code

A análise identificou que cada requisição concorrente estava realizando sua própria renovação.

A solução proposta foi utilizar uma Promise compartilhada:

```ts
private renovacaoEmAndamento: Promise<string> | null = null;
```

com a renovação protegida por:

```ts
if (this.renovacaoEmAndamento) {
  return this.renovacaoEmAndamento;
}
```

e limpeza em `finally`.

### Eu

Após implementar a solução, adicionei cenários próprios para:

* reutilização do token válido;
* nova renovação após expiração;
* concorrência menor;
* segunda onda de requisições após uma nova expiração.

Resultado:

```text
PASS test/caso-3-token.spec.ts

√ renova o token uma unica vez
√ nenhuma requisicao morre por token invalido
√ reutiliza o token enquanto ele ainda estiver valido
√ renova novamente quando o token expira
√ mantem uma unica renovacao com concorrencia menor
√ faz uma nova renovacao em uma segunda onda apos nova expiracao

Tests: 6 passed, 6 total
```

### Claude Code

> Os testes cobrem bem os cenários que o enunciado pede — token único sob 50 chamadas simultâneas, reaproveitar enquanto válido, renovar de novo após nova expiração, ondas sucessivas com concorrência menor. É um bom conjunto.

---

## 11.4 Exemplo do processo iterativo

Os trechos acima representam o padrão utilizado durante o desafio:

```text
Problema observado
        ↓
Hipótese técnica
        ↓
Discussão com a IA
        ↓
Implementação
        ↓
Execução dos testes
        ↓
Análise das falhas
        ↓
Novos testes próprios
        ↓
Revisão das limitações
        ↓
Decisão final
```

A utilização da IA foi, portanto, parte do processo de desenvolvimento e revisão, mas as decisões finais sobre arquitetura, implementação, testes e escopo foram tomadas após minha própria análise dos resultados.
