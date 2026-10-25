# Arquitetura

Este documento explica as decisões técnicas do processador de transações de apostas, os trade-offs de cada uma e as interpretações feitas onde o enunciado deixa espaço.

## Visão geral

O código é organizado por módulo de negócio, e cada módulo em três camadas:

```
src/
  shared/      Money, erros base, backoff, eventos de integração, portas comuns (Clock, IdGenerator, UnitOfWork)
  wallet/      Wallet (aggregate root), lançamentos do ledger, abertura de wallet
  wagering/    WagerTransaction, máquina de estados, hash do payload, política de referências pendentes
  messaging/   inbox e outbox
```

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | Entidades, value objects, regras e eventos. TypeScript puro, sem framework e sem I/O | nada |
| `application` | Casos de uso e **portas** (interfaces de repositório, `UnitOfWork`, `Clock`) | `domain` |
| `infrastructure` | Adaptadores: MikroORM, SQS, HTTP | `application`, `domain` |

O domínio não conhece o ORM: não há decorators nem tipos do MikroORM nas entidades. Os testes unitários do domínio rodam sem banco, e o banco pode mudar sem tocar nas regras de negócio.

## Escolha do ORM: MikroORM

O enunciado prefere MikroORM, e ele também é a melhor escolha técnica para este problema:

- **Unit of Work explícito.** `em.transactional()` abre uma transação, e tudo o que foi persistido é gravado num único `flush` no commit. Esse é o modelo de "um comando = uma transação" que o desafio exige (transação, wallet, ledger e outbox juntos).
- **Lock pessimista nativo.** `findOne(..., { lockMode: LockMode.PESSIMISTIC_WRITE })` gera `SELECT ... FOR UPDATE`, e `PESSIMISTIC_PARTIAL_WRITE` gera `FOR UPDATE SKIP LOCKED`, que o publicador do outbox vai usar.
- **Mapeamento sem decorators (`EntitySchema`).** O mapeamento fica na infraestrutura, em classes de registro que espelham as linhas das tabelas (`WalletRecord`, `WagerTransactionRecord` etc.). Mappers convertem registro ↔ domínio.
- **Migrations versionadas e reversíveis**, escritas à mão em SQL (`up` e `down`), executadas em transação com `allOrNothing`.
- **Query builder** para o que o ORM não expressa direto, por exemplo `INSERT ... ON CONFLICT DO NOTHING` no inbox.

### Trade-offs encontrados

| Problema | Decisão |
|---|---|
| A CLI do MikroORM 7 roda em Node e não carrega TypeScript com `enum` | As migrations rodam por um script em Bun (`scripts/migrate.ts`) que usa a API `orm.migrator` |
| O identity map pode devolver uma cópia da wallet lida **antes** do lock | `findByIdForUpdate` usa `refresh: true`: a linha sempre vem do `SELECT ... FOR UPDATE` |
| O Unit of Work não garante a ordem dos `INSERT`s entre entidades sem relação mapeada | As FKs do ledger e da referência são `DEFERRABLE INITIALLY DEFERRED` (migration `DeferrableLedgerForeignKeys`); são verificadas no `COMMIT` |
| Mapear o domínio direto como entidade do ORM exigiria construtores públicos e setters | Registros separados + mappers. Custa um pouco de código repetido; ganha domínio fechado (construtores privados, estado imutável por fora) |

### Semântica de `add` e `save`

Os repositórios **copiam** o estado do agregado para o registro no momento da chamada. Se o agregado mudar depois, é preciso chamar `save` de novo. A escrita fica explícita no caso de uso, e nada é gravado por acidente porque um objeto foi alterado em memória.

## Mapeamento do Money

Dinheiro nunca passa por `number` (ponto flutuante binário: `0.1 + 0.2 !== 0.3`).

| Onde | Representação |
|---|---|
| API (JSON) | `{ "amount": "25.00", "currency": "BRL" }` — string com exatamente 2 casas decimais |
| Domínio | `Money`: value object imutável, valida o formato com regex estrita (`^(0\|[1-9]\d*)\.\d{2}$`), no máximo 18 dígitos inteiros |
| Aritmética | `decimal.js` com precisão 40 e arredondamento `ROUND_HALF_EVEN`, só dentro de `Money` |
| Banco | `numeric(20, 2)`: decimal exato, cabe o limite de 18 dígitos inteiros |
| ORM | `type: "decimal"`, que no MikroORM 7 mapeia para **string**; o mapper reconstrói com `Money.fromSigned` |

Por que string com 2 casas e não inteiro em centavos (`bigint`):

- O valor no JSON é legível e idêntico ao do banco e do ledger; não há conversão ×100 em cada fronteira.
- `numeric` é exato no Postgres; a vantagem de desempenho de `bigint` não importa neste volume.
- Moedas com outra quantidade de casas ficam fora do escopo; o formato é validado e qualquer valor diferente é rejeitado com `VALIDATION_ERROR`, em vez de ser arredondado em silêncio.

Operações entre moedas diferentes lançam `CurrencyMismatchError`. A moeda da wallet é fixa e o banco garante, por FK composta `(wallet_id, currency)`, que o ledger só tem lançamentos na moeda da wallet.

## Estratégia transacional

### Um comando, uma transação

Cada comando (abrir wallet, processar transação) roda em **uma** transação do Postgres via `UnitOfWork.run`. Dentro dela são gravados juntos: a transação de aposta, a wallet, o lançamento do ledger e o evento no outbox. Ou tudo é commitado, ou nada.

### Concorrência: lock pessimista por wallet

- Nível de isolamento: `READ COMMITTED` (padrão do Postgres).
- Quem vai mexer no saldo lê a wallet com `SELECT ... FOR UPDATE`. Duas instâncias processando a mesma wallet ficam em fila **naquela linha**; wallets diferentes processam em paralelo.
- Teste: saldo 100.00, duas apostas paralelas de 80.00 → uma processada, outra rejeitada, saldo final 20.00.

Por que pessimista e não só otimista (versão + retry): numa wallet "quente" (um jogador com muitas apostas seguidas), o otimista gera uma tempestade de conflitos e retries. O lock serializa só o que precisa ser serializado e cada transação espera, no máximo, as anteriores da mesma wallet.

Por que não `SERIALIZABLE`: as invariantes já estão protegidas por lock e constraints; `SERIALIZABLE` aumentaria os aborts sem ganho de correção.

### Segunda linha de defesa: versão e triggers

- O trigger `wallets_guard` exige que toda mudança de saldo incremente `version` em exatamente 1. Em `READ COMMITTED`, o `UPDATE` que esperou outro commit é reavaliado sobre a linha mais nova, então um código que esqueça o lock é **barrado**, e o saldo não é sobrescrito com um valor antigo. Há teste que faz isso de propósito.
- Triggers deferidos verificam no `COMMIT` que saldo e ledger batem (`wallets_assert_ledger`, `ledger_assert_wallet_and_transaction`).

### Tempo limite e retry

- Cada transação começa com `SET LOCAL lock_timeout = '5000ms'`. Uma wallet travada não prende conexões do pool indefinidamente.
- `deadlock_detected` (`40P01`), `serialization_failure` (`40001`) e `lock_not_available` (`55P03`) causam rollback e nova tentativa, até 3 vezes, com backoff curto e jitter. A função de trabalho não pode ter efeito fora do banco, e não tem: eventos vão para o outbox.
- Se as tentativas acabarem, ou o banco estiver fora, o erro vira `TransientInfrastructureError` (a API responderá 503; o cliente pode repetir com a mesma `Idempotency-Key`).
- Violações de `UNIQUE` viram `UniqueConstraintConflictError` com o nome da constraint. O caso de uso decide o significado: na abertura de wallet, `uq_wallets_player_currency` significa "outra requisição criou primeiro" → `WalletAlreadyExistsError`.

## API HTTP

### Status codes

O provedor precisa decidir **só pelo status** se reenvia a requisição, sem interpretar a mensagem. Cada situação tem um código próprio, igual em todos os endpoints:

| Situação | Status | Reenviar? |
|---|---|---|
| Criado / transação processada | `201` | — |
| Replay de transação processada | `200` + `idempotentReplay: true` | — |
| Aceita, aguardando a referência | `202` | não; consultar depois |
| Payload inválido (formato, tipo, `Money` mal formado, cursor inválido, `Idempotency-Key` ausente) | `400` com `VALIDATION_ERROR`, `KIND_NOT_ALLOWED`, `REFERENCE_REQUIRED` ou `REFERENCE_NOT_ALLOWED` | só depois de corrigir |
| Recurso não encontrado | `404` | não |
| Conflito (wallet duplicada, `IDEMPOTENCY_CONFLICT`) | `409` | não |
| Transação rejeitada por regra de negócio (persistida) | `422` + `failureCode`, igual no replay | não |
| Falha transitória (banco fora, lock timeout esgotado) | `503 INFRASTRUCTURE_UNAVAILABLE` + `Retry-After` | sim |
| Erro inesperado | `500 INTERNAL_ERROR` (logado com stack) | — |

O mapeamento fica num só lugar, `ApiExceptionFilter`. Os casos de uso lançam erros de domínio ou de aplicação, sem saber nada de HTTP, e o filtro traduz pelo `code` do erro. O módulo compartilhado não importa os erros de cada módulo.

### Formato de erro

Inspirado no RFC 9457 (Problem Details), com `Content-Type: application/problem+json`:

```json
{ "type": "urn:wagering:problem:validation-error", "title": "Invalid request", "status": 400,
  "code": "VALIDATION_ERROR", "detail": "invalid request",
  "issues": [{ "path": "initialBalance.amount", "message": "Invalid input: expected string, received number" }],
  "correlationId": "6b43845b-..." }
```

Erros do próprio framework (JSON malformado, rota inexistente) saem no mesmo formato.

**Exceção deliberada: a rejeição de transação (`422`).** Uma rejeição é um resultado **gravado**, que o replay devolve igual. O corpo é a própria transação (`transactionId`, `status: "REJECTED"`, `failureCode`, `failureCategory`, `balance`, `idempotentReplay`) mais `type`, `title` e `code` do Problem Details. O membro `status` do RFC (que repetiria o código HTTP) é omitido porque, no contrato do desafio, `status` é o estado da transação. O código HTTP continua na linha de status da resposta.

### Validação na borda

- O zod confere só o **formato** da requisição (campos presentes, tipos, UUIDs, limites de paginação).
- O formato do valor monetário e a moeda são validados por `Money`, que é a única fonte dessas regras. Não existe uma regex de dinheiro duplicada no controller.
- Um id que não é UUID responde `400` antes de chegar ao banco. Sem isso, o Postgres recusaria o cast, e o erro viraria `500`.

### Correlation id

Toda requisição tem um `x-correlation-id`: o recebido, se for bem formado (até 128 caracteres de `[A-Za-z0-9_.:-]`), ou um UUID novo. Ele volta no header da resposta, aparece no corpo dos erros e vai para os eventos do outbox, o que permite seguir uma operação da API até a fila.

### Paginação do ledger

- O cursor é a última `sequence` devolvida, junto com o `walletId`, em JSON e base64url. Para o cliente ele é **opaco**: o formato pode mudar sem quebrar a API.
- É **estável**: o ledger é append-only e `sequence` é contínua por wallet, então lançamentos novos entram no fim e nunca deslocam as páginas já lidas. Paginação por `offset` não teria essa garantia.
- O cursor de uma wallet não vale em outra (`400`).
- `limit` vai de 1 a 200, com padrão 50. O repositório busca `limit + 1` linhas para saber se existe próxima página sem fazer um `COUNT`.

### Reconciliação

`POST /wallets/:walletId/reconciliation` compara o saldo gravado na wallet com a soma dos lançamentos do ledger.

- As duas leituras rodam numa transação **`REPEATABLE READ` somente leitura** (`UnitOfWork.snapshot`). Em `READ COMMITTED`, um débito commitado entre a leitura da wallet e a soma do ledger apareceria como divergência falsa.
- A divergência **não é corrigida**: a resposta traz `consistent: false` e a diferença, e o caso de uso avisa um `ReconciliationReporter` (hoje um log de erro; a métrica entra com a observabilidade). Corrigir automaticamente esconderia justamente o bug que a reconciliação existe para achar.
- Com os triggers, uma divergência não deveria conseguir existir. O teste que a provoca precisa desligá-los (`session_replication_role = replica`) dentro de uma transação.

## Garantias do banco

O domínio valida as regras para dar erros claros; o banco as repete para que fiquem impossíveis de violar, mesmo com bug na aplicação.

| Invariante | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK` |
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Toda mudança de saldo tem lançamento no ledger, e vice-versa | `wallets_guard` + triggers deferidos + cadeia do ledger |
| Ledger append-only, sem buracos, aritmética fechada | triggers + `CHECK` + `UNIQUE (wallet_id, sequence)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Uma transação é revertida no máximo uma vez | índice único parcial `uq_wtx_single_reversal` |
| Estado terminal não muda; campos de negócio imutáveis | trigger `wager_transactions_guard` |
| Mensagem consumida uma vez por consumidor | `PRIMARY KEY (consumer_name, message_id)` no inbox |

Os testes de integração em `test/integration/database` escrevem SQL direto, sem passar pelo domínio, e conferem o nome exato da constraint que barrou cada violação.

## Processamento de transações

O fluxo de um comando, vindo do HTTP ou da fila, é o mesmo caso de uso, `SubmitWagerTransactionUseCase`. A persistência da transação, a alteração de saldo, o lançamento do ledger, o inbox (quando a entrada é a fila) e os eventos do outbox acontecem **numa única transação SQL**.

```
validar contrato (Money + WagerTransaction.create)     → 400, nada gravado
  │
  ├─ chave ou (provider, external id) já existe
  │     mesmo payload  → replay (200 / 202 / 422 original)
  │     payload outro  → 409 IDEMPOTENCY_CONFLICT
  │
  └─ lock da wallet (FOR UPDATE)
        ├─ wallet inexistente / outro player / outra moeda → REJECTED persistido (422)
        ├─ referência ausente ou ainda pendente            → PENDING_REFERENCE (202)
        ├─ referência inválida ou saldo insuficiente       → REJECTED persistido (422)
        └─ aplica débito/crédito (exceto LOSS)             → PROCESSED (201)
```

A decisão de negócio (processar, rejeitar, esperar) está em `WagerSettlement`, TypeScript puro. O caso de uso só carrega o que ela precisa (wallet com lock, avaliação da referência, ids) e grava o resultado.

### Idempotência

- O header `Idempotency-Key` é **obrigatório** e é a fonte da verdade. O valor recomendado é `{providerId}:{externalTransactionId}`.
- `payloadHash = sha256(canonicalJson(campos de negócio))`, hexadecimal. O header, `correlationId` e qualquer metadado de transporte **não entram** no hash.
- Mesma key e mesmo hash → a resposta original, com `idempotentReplay: true`. Isso vale para processada, rejeitada e pendente: o replay de uma rejeição continua `422`.
- Mesma key com outro payload, ou o mesmo `(providerId, externalTransactionId)` sob outra key → `409 IDEMPOTENCY_CONFLICT`. Não é replay.
- Pedido inválido (formato, `OPENING`, REFUND sem referência) **não é gravado**. Corrigir e reenviar com a mesma key é o caminho certo; se gravássemos o 400, a key ficaria presa a um erro de digitação.
- Duas requisições idênticas em paralelo: uma commita, a outra toma o unique (`uq_wtx_idempotency_key` ou `uq_wtx_provider_external`) e vira replay. Sem wallet (não há linha para lockar) é exatamente esse o caminho.

### Algoritmo do `payloadHash`

1. Montar o objeto só com os campos de negócio, nesta lista fixa: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId` (omitido se `undefined`).
2. Canonicalizar: chaves de cada objeto em ordem lexicográfica, sem espaço, `undefined` omitido. Arrays (não usamos nenhum hoje) mantêm a ordem.
3. `sha256` do UTF-8 desse JSON, digest em hex (64 caracteres).

A lista de campos é explícita de propósito: um campo novo no JSON (comentário, locale) não muda o hash. `JSON.stringify` puro não serve — a ordem das chaves no objeto de entrada é indefinida.

### Referência pendente

`REFUND`/`ROLLBACK` (e `WIN`/`LOSS` quando apontam para uma BET) buscam a referência por `(providerId, referenceExternalTransactionId)`.

| Situação da referência | Resultado |
|---|---|
| Ainda não chegou, ou ela mesma está `PENDING_REFERENCE` | `PENDING_REFERENCE`, `next_retry_at` pelo backoff (10 tentativas, 2 s dobrando até 10 min, ~27 min) |
| `REJECTED` / `FAILED` | `REFERENCE_NOT_PROCESSED` — nunca vai virar `PROCESSED` |
| Outro player / wallet / moeda / rodada / provider | `REFERENCE_MISMATCH` |
| Tipo que a operação não pode referenciar | `REFERENCE_KIND_NOT_ALLOWED` |
| Valor da reversão ≠ valor da referência | `AMOUNT_MISMATCH` |
| Já tem REFUND ou ROLLBACK `PROCESSED` | `REFERENCE_ALREADY_REVERSED` |
| Esgotou as tentativas sem ela chegar | `REFERENCE_NOT_FOUND` |

A checagem da wallet vem **antes** da referência: transação para wallet inexistente é `WALLET_NOT_FOUND` na hora, não fica pendente. Wallet não chega "fora de ordem".

### Worker de referências pendentes

`ProcessDuePendingReferencesUseCase` retoma as linhas vencidas. Cada linha roda na **sua** transação SQL:

1. `SELECT ... WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= now() ORDER BY next_retry_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`
2. Lock da wallet (`FOR UPDATE`)
3. O mesmo `WagerSettlement` do submit: processa, rejeita ou agenda a próxima tentativa
4. Grava transação, ledger (se houver) e outbox

`SKIP LOCKED` faz N instâncias dividirem o trabalho sem pegar a mesma linha. Uma linha travada por outra instância é pulada; o próximo tick a vê se ainda estiver devida.

O worker do Nest (`PendingReferenceWorker`) faz poll a cada `PENDING_REFERENCE_POLL_INTERVAL_MS` (padrão 500 ms). Se o lote sai cheio, o próximo tick é imediato (há fila). Em `test` ele não sobe — os testes de API não competem com o poller. `WORKERS_ENABLED=false` desliga em qualquer ambiente.

Não reprocesso a pendente **dentro** do submit da BET. Isso inverteria a ordem dos locks (submit já tem a wallet e iria atrás da pendente; o worker já tem a pendente e vai atrás da wallet) e geraria deadlock. A latência extra é no máximo um intervalo de poll depois que `next_retry_at` vence; o índice `ix_wtx_pending_by_reference` fica pronto se essa otimização valer o risco depois.

O `correlationId` dos eventos do worker é `pending-reference:{transactionId}`; o `causationId` é a própria transação.

## Publicação da outbox

O evento nasce na mesma transação SQL da mudança financeira. Publicar no SQS é outro sistema, então acontece **depois** do commit, num worker (`PublishOutboxUseCase`).

A publicação não segura a transação aberta: uma conexão do pool não fica esperando rede. No lugar disso, a linha é **alugada**:

1. Transação curta: `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until <= now()) ORDER BY occurred_at, id LIMIT n FOR UPDATE SKIP LOCKED`, grava `locked_by` e `locked_until = now() + 30s`, commit.
2. Fora da transação: `SendMessage` na fila FIFO `integration-events.fifo`.
3. Outra transação curta. Se o lease ainda é nosso: `published_at = now()`. Se o envio falhou e o lease ainda é nosso: `attempts++`, `next_attempt_at` pelo backoff (1 s, dobrando até 5 min, jitter de 20%) e o lease é solto.

`SKIP LOCKED` reparte as linhas entre instâncias. O lease impede que a segunda pegue a linha da primeira **enquanto ela publica**. Se o processo morre no meio, o lease vence e outra instância assume. Nada é apagado: a outbox nunca desiste de um evento commitado.

Garantia: **at-least-once**. Morrer depois do `SendMessage` e antes de marcar `published_at` publica de novo. O `MessageDeduplicationId` é o `eventId`, então o SQS descarta a repetição dentro da janela de 5 minutos — otimização, não a garantia. Quem consome deduplica pelo `eventId`, e isso vale depois da janela também.

Um teste sobe um processo só para publicar e mata esse processo nesse intervalo (`process.exit` depois do envio, antes de gravar `published_at`). A linha fica alugada e sem `published_at`. Quando o lease vence, outro processo marca o evento. O relógio adiantado dos testes de unidade cobre a mesma regra; este cobre o processo de verdade.

`MessageGroupId` é o `aggregateId`. Eventos do mesmo agregado saem na ordem de `occurredAt`; agregados diferentes publicam em paralelo. Se o envio de um evento falha, os seguintes **do mesmo agregado** voltam para a fila com o mesmo `next_attempt_at`, sem contar tentativa: anunciar o saldo novo antes do antigo seria pior do que esperar o backoff. Um agregado que falhou não segura os outros.

Falha de envio não perde o evento: a linha continua pendente, com `last_error`, e volta quando o backoff passa. O `/health/ready` só fica de pé se o Postgres, a fila de apostas e a fila de eventos respondem.

O worker segue o mesmo ciclo do de referências pendentes (`OUTBOX_POLL_INTERVAL_MS`, lote de 20) e também fica desligado em `test`.

## Consumo da fila de apostas

A fila `wager-transactions.fifo` carrega `WagerTransactionRequested`. O `messageId` do corpo é o id estável do produtor: é a chave do inbox (`consumer_name = wager-transactions`) e o `correlationId`/`causationId` dos eventos. O `MessageId` do SQS muda de significado a cada redrive e **não** entra no inbox. A `idempotencyKey` vem de `data`, ou de `{providerId}:{externalTransactionId}` quando o campo falta.

O ack é um `DeleteMessage` **depois** do commit. Cair entre o commit e o ack devolve a mensagem; o inbox vê o mesmo `messageId` e o caso de uso responde o resultado já gravado, sem debitar de novo. A janela de deduplicação do FIFO (5 minutos, por `MessageDeduplicationId`) é otimização: duas cópias com ids de deduplicação diferentes, ou uma cópia que volta depois da janela, continuam seguras por causa do inbox e da `idempotencyKey`.

| O que aconteceu | O que a fila faz |
|---|---|
| Processada, rejeitada, pendente ou replay | ack. Rejeição de negócio já está gravada; repetir devolveria o mesmo `422` |
| JSON inválido, contrato inválido (`OPENING`, dinheiro mal formado), `IDEMPOTENCY_CONFLICT` | cópia para a DLQ e delete. Retentar não muda o resultado |
| Banco fora, deadlock, erro inesperado | `ChangeMessageVisibility` com backoff (1 s, dobrando, teto 60 s). Não é deletada |
| Cinco recebimentos sem ack | o redrive da fila (`maxReceiveCount` 5) move para `wager-transactions-dlq.fifo` |

O veneno vai direto para a DLQ para não gastar as cinco tentativas. A falha transitória **não** é deletada: quem move para a DLQ é o redrive, depois do limite. A DLQ é FIFO; o grupo é o da mensagem original (a wallet) e o `MessageDeduplicationId` é o id do SQS, então um reenvio do mesmo veneno não duplica a cópia dentro da janela.

`MessageGroupId` é a wallet. O long poll espera até `WAGER_CONSUMER_WAIT_SECONDS` (10 s) e a visibilidade padrão é 30 s, igual ao timeout da fila. Várias instâncias competem: o SQS entrega cada mensagem a uma só enquanto ela está invisível.

No SIGTERM o loop para de receber, aborta o long poll e espera `WAGER_CONSUMER_SHUTDOWN_TIMEOUT_MS` (10 s) pelo que já começou. O que terminou é confirmado. O que não terminou, e o lote que chegou depois do sinal, volta com visibilidade 0. Quem devolve o recibo é o dono dele: um ack atrasado não apaga a reentrega. O worker fica desligado em `test`, como os outros dois.

Três processos consomem a mesma fila no teste, cada um com lote 1, e cada aposta debita uma vez. Outro processo é morto depois do commit e antes do ack: o saldo já mudou, a mensagem volta quando a visibilidade acaba, e o processo seguinte acha o inbox e não debita de novo. O `process.exit` fica no processo de teste; a API não instala esse gancho.

## Interpretações

- **Saldo inicial.** Uma wallet aberta com saldo positivo ganha uma transação interna `OPENING` (provider `internal`), já `PROCESSED`, com o lançamento de crédito correspondente e um evento `WalletBalanceChanged`. Assim o saldo sempre é explicado pelo ledger. Wallet com saldo zero não tem lançamento.
- **Uma wallet por jogador e moeda.** Abrir a segunda na mesma moeda é conflito; em outra moeda é permitido.
- **`wager_transactions.wallet_id` sem FK.** Uma requisição para wallet inexistente é gravada como `REJECTED` (`WALLET_NOT_FOUND`) para que o replay devolva a mesma resposta. Quem precisa de integridade com a wallet é o ledger, e ele tem FK.
- **Uma reversão de crédito por transação.** Uma BET aceita no máximo um `REFUND` ou um `ROLLBACK` processado — o primeiro que chegar. O segundo é `REFERENCE_ALREADY_REVERSED`. O índice único parcial `uq_wtx_single_reversal` é a garantia final quando dois chegam juntos: o perdedor da corrida é reavaliado e vira a mesma rejeição. `ROLLBACK` de um `REFUND` continua permitido (desfaz o reembolso).
- **WIN numa BET já reembolsada.** Rejeitado com `REFERENCE_ALREADY_REVERSED`: rodada cancelada não paga prêmio.
- **LOSS.** Gera `WagerTransactionProcessed` e não mexe no saldo nem no ledger. Valor zero é permitido só nela.
- **WIN e LOSS sem referência.** Permitido. Quando a referência vem, precisa ser a BET da mesma rodada.
- **`REVERSAL_INSUFFICIENT_FUNDS`.** Código próprio, separado de `INSUFFICIENT_FUNDS`: o jogador já tinha o crédito (WIN/REFUND) e o gastou; o ROLLBACK não cabe. É alerta operacional, não "jogador sem saldo".
- **Pedido inválido não é persistido.** `OPENING` pela API, REFUND sem referência, dinheiro mal formatado → `400` e a key continua livre.

## Observabilidade

Cada requisição HTTP ganha um `x-correlation-id` (o que veio, se for bem formado, ou um UUID) e esse valor fica no contexto assíncrono da chamada. O log é JSON, uma linha por evento, pelo pino. A linha de acesso traz método, caminho, status e duração. Não traz query string, corpo, `playerId` nem valor em dinheiro: o caminho da carteira e o id da transação bastam para achar a operação, e o saldo continua só no banco e na resposta.

O mesmo `correlationId` vai nos eventos. Na fila, o `messageId` do corpo entra no log da decisão. O `GET /metrics` fala o formato do Prometheus:

| Métrica | O que conta |
|---|---|
| `wager_transactions_total{kind,status}` | decisão gravada agora. Replay não entra. Uma pendente que depois processa conta de novo, com o status novo |
| `wager_duplicates_total{source,type}` | `http` ou `sqs`; `idempotency` (mesma key) ou `inbox` (mesma mensagem) |
| `wager_retries_total{reason}` | `deadlock`, `lock_timeout`, `serialization_failure`, `pending_reference`, `outbox_publish`, `sqs_visibility` |
| `wallet_lock_conflicts_total{reason}` | só deadlock e timeout de lock |
| `sqs_dlq_messages_total` | mensagem copiada para a DLQ |
| `wager_processing_duration_seconds` | tempo para decidir uma transação |
| `outbox_pending_messages`, `outbox_lag_seconds` | lidos na hora do scrape: quantas linhas falta publicar, e a idade da mais antiga |
| `reconciliation_divergences_total` | uma checagem cujo saldo armazenado não fecha com o ledger |

O contador só anda depois que a transação SQL voltou. Um deadlock que dá rollback e tenta de novo não vira duas decisões. O lag da outbox não é empurrado pelo publicador: quem raspa vê o banco naquele instante. `/health/live` e `/health/ready` continuam sem corpo de negócio. `/metrics` também não exige autenticação, no mesmo espírito do health: quem chega na porta já está na rede interna.

## Ainda por documentar

As próximas etapas completam este documento: autenticação (no-op + desenho) e limitações conhecidas.
