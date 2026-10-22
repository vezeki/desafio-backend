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
| `bun run migration:create` / `migration:up` / `migration:down` | migrations |

## Health checks

- `GET /health/live` — processo vivo
- `GET /health/ready` — PostgreSQL e SQS alcançáveis
