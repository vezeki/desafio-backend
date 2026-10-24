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
| `409` | conflito (wallet duplicada) | não |
| `422` | regra de negócio violada | não |
| `503` | infraestrutura indisponível, com `Retry-After` | sim |

Toda resposta traz `x-correlation-id`. Se a requisição enviar esse header, o mesmo valor é usado nos logs e nos eventos.

## Health checks

- `GET /health/live` — processo vivo
- `GET /health/ready` — PostgreSQL e SQS alcançáveis
