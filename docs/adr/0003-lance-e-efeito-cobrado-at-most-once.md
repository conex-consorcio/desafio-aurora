# ADR-0003 — Lance é efeito cobrado: reserva antes da chamada e at-most-once

- **Status:** aceito
- **Data:** 2026-09-29

## Contexto

`POST /lances/registrar` na Aurora cobra por chamada e não deduplica: a mesma
cota registrada duas vezes na mesma assembleia são dois lances cobrados, e o
segundo pode invalidar o primeiro. Não existe consulta de lance registrado e
a requisição não aceita identificador nosso (confirmado com a Aurora em
2026-09-28). O único sinal de duplicata, `vezRegistrada`, chega **depois** de
a chamada ter saído.

O registro rodava como ler → decidir → chamar → gravar. Com oito instâncias
acordando no mesmo segundo no dia 1, todas liam o banco vazio e todas
chamavam. Com duas instâncias, oito chamadas simultâneas chegaram cinco e
seis vezes ao parceiro.

## Decisão

1. **A proteção fica antes do efeito externo.** A linha de `lances` nasce
   como reserva (`situacao = PENDENTE`, sem protocolo) e a unicidade em
   `(grupo, cota, assembleia)` decide quem é o dono. Só o dono chama a
   Aurora; quem perde espera o protocolo do dono aparecer na linha e devolve
   o mesmo. Não há transação aberta durante o HTTP nem lock com TTL: a
   reserva é durável e não expira sozinha.

2. **At-most-once para a chamada cobrada.** Quando a chamada do dono falha,
   o cliente diz se a requisição pode ter saído (`ParceiroFalhaError.efeitoDesconhecido`):
   - **não saiu** (conexão não abriu, ou a Aurora respondeu com erro): a
     reserva é apagada e a chave volta a ficar disputável;
   - **pode ter saído** (timeout, socket fechado sem resposta, ou `502`/`504`
     de um gateway na frente da Aurora): a reserva fica `PENDENTE` e
     **ninguém a repete automaticamente**.

   Sem consulta nem chave de idempotência do lado da Aurora, não existe
   exactly-once. Entre cobrar duas vezes e deixar uma cota sem lance, escolhemos
   o segundo, porque ele é visível e reversível por gente; o primeiro não é.

3. **Quem espera tem prazo.** Um concorrente espera até 15s pelo dono. Se o
   dono morreu no meio, a resposta é `202` com `situacao: PENDENTE`: a
   operação existe e não terminou. O scheduler não espera: perdeu a reserva,
   segue para a próxima cota.

## Consequências

- Uma reserva `PENDENTE` antiga é um fato a reconciliar, não um bug a
  reprocessar. Ela aparece no log (`reserva mantida PENDENTE`) e é
  consultável por `situacao` e `reservadoEm`. Hoje a reconciliação é manual.
- Se a Aurora passar a aceitar um identificador nosso ou a expor consulta por
  cota e assembleia, a reserva pendente vira transitória: basta consultar (ou
  reenviar com o mesmo identificador) antes de decidir. A estrutura já
  comporta isso.
- A resposta de `POST /lances/registrar` passou a ser uma união
  (`REGISTRADO` com protocolo, ou `PENDENTE`). Quem consome é obrigado pelo
  tipo a tratar o segundo caso.
- Uma base com lances já duplicados para a mesma chave precisa ser limpa
  antes da migration; a migration não decide qual dos dois é o válido.
