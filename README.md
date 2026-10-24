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
| `bun run infra:up` / `infra:down` | sobe / derruba a infraestrutura local |
| `bun run migration:up` / `migration:down` / `migration:status` | aplica, reverte ou lista as migrations |

## Testes

Os testes de integração usam o PostgreSQL do Docker Compose, num banco separado (`wagering_test`) que é criado e migrado automaticamente na primeira execução. Para apontar para outro banco, defina `TEST_DATABASE_URL`.

Os testes não limpam tabelas entre execuções: o ledger é append-only também no banco de teste. Cada teste cria seus próprios ids.

## Health checks

- `GET /health/live` — processo vivo
- `GET /health/ready` — PostgreSQL e SQS alcançáveis
