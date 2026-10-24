# Distributed Wagering Processor

Serviço de carteira que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de provedores de jogos via HTTP e SQS.

Decisões técnicas e trade-offs: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Requisitos

- Bun 1.x
- Docker + Docker Compose

## Setup

```bash
bun install
cp .env.example .env
bun run infra:up          # PostgreSQL + LocalStack (filas FIFO + DLQ)
bun run migration:up
bun run start
```

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start` | sobe a API |
| `bun run dev` | sobe a API com reload |
| `bun run typecheck` | checagem de tipos |
| `bun run test` | todos os testes |
| `bun run test:unit` | testes de unidade |
| `bun run test:integration` | testes de integração (requer `infra:up`) |
| `bun run test:concurrency` | testes de concorrência (requer `infra:up`) |
| `bun run test:e2e` | testes da API HTTP com a aplicação inteira de pé (requer `infra:up`) |
| `bun run infra:up` / `infra:down` | sobe / derruba a infraestrutura local |
| `bun run migration:up` / `migration:down` / `migration:status` | aplica, reverte ou lista as migrations |

## Testes

Os testes de integração usam o PostgreSQL do Docker Compose, num banco separado (`wagering_test`) que é criado e migrado automaticamente na primeira execução. Para apontar para outro banco, defina `TEST_DATABASE_URL`.

Os testes não limpam tabelas entre execuções: o ledger é append-only também no banco de teste. Cada teste cria seus próprios ids.

## API

Valores monetários são sempre `{ "amount": "25.00", "currency": "BRL" }`, com o valor em string e exatamente duas casas decimais.

### Wallets

```bash
# criar (saldo inicial > 0 gera a transação interna OPENING e o lançamento no ledger)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl localhost:3000/wallets/{walletId}
curl 'localhost:3000/wallets/{walletId}/ledger?limit=50'           # próxima página: &cursor={nextCursor}
curl -X POST localhost:3000/wallets/{walletId}/reconciliation      # compara o saldo com a soma do ledger
```

### Transações (BET, WIN, LOSS, REFUND, ROLLBACK)

```bash
curl -i -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"{playerId}","walletId":"{walletId}","roundId":"round-987","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

curl localhost:3000/wagering/transactions/{transactionId}
curl localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. `Idempotency-Key` é obrigatório: repetir a mesma requisição devolve o resultado original com `"idempotentReplay": true`.

Se a referência ainda não chegou, a API responde `202` e um worker retoma a transação quando `next_retry_at` vence (`FOR UPDATE SKIP LOCKED`, várias instâncias). Depois de 10 tentativas (~27 min) ela vira `REJECTED` com `REFERENCE_NOT_FOUND`.

Os eventos commitados (transação processada, rejeitada, saldo alterado, referência pendente) vão para a fila `integration-events.fifo`. O publicador aluga a linha por 30 s, publica fora da transação e marca `published_at`. Várias instâncias dividem a outbox. Se o processo morre no meio, o lease vence e outra publica. Um envio repetido é seguro: o consumidor deduplica pelo `eventId`.

Os dois workers sobem com a API e ficam desligados em teste. `WORKERS_ENABLED=false` desliga os dois em qualquer ambiente.

| Status | Significado |
|---|---|
| `201` | processada |
| `200` | replay de uma transação processada |
| `202` | aguardando a transação referenciada (`PENDING_REFERENCE`) |
| `422` | rejeitada por regra de negócio, com `failureCode` (também no replay) |
| `409` | `IDEMPOTENCY_CONFLICT`: mesma key com outro payload |

### Erros

Todos os endpoints respondem erro no mesmo formato (`application/problem+json`):

```json
{ "type": "urn:wagering:problem:wallet-already-exists", "title": "Wallet already exists", "status": 409,
  "code": "WALLET_ALREADY_EXISTS", "detail": "...", "correlationId": "..." }
```

| Status | Significado | Reenviar? |
|---|---|---|
| `400` | payload inválido (`VALIDATION_ERROR`, com a lista de `issues`) | só depois de corrigir |
| `404` | recurso não existe | não |
| `409` | conflito (wallet duplicada, conflito de idempotência) | não |
| `422` | regra de negócio violada | não |
| `503` | infraestrutura indisponível, com `Retry-After` | sim |

Toda resposta traz `x-correlation-id`. Se a requisição enviar esse header, o mesmo valor é usado nos logs e nos eventos.

## Health checks

- `GET /health/live` — processo vivo
- `GET /health/ready` — PostgreSQL e as duas filas SQS (apostas e eventos) alcançáveis
