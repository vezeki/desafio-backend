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

## Interpretações

- **Saldo inicial.** Uma wallet aberta com saldo positivo ganha uma transação interna `OPENING` (provider `internal`), já `PROCESSED`, com o lançamento de crédito correspondente e um evento `WalletBalanceChanged`. Assim o saldo sempre é explicado pelo ledger. Wallet com saldo zero não tem lançamento.
- **Uma wallet por jogador e moeda.** Abrir a segunda na mesma moeda é conflito; em outra moeda é permitido.
- **`wager_transactions.wallet_id` sem FK.** Uma requisição para wallet inexistente é gravada como `REJECTED` (`WALLET_NOT_FOUND`) para que o replay devolva a mesma resposta. Quem precisa de integridade com a wallet é o ledger, e ele tem FK.

## Ainda por documentar

As próximas etapas completam este documento: API HTTP e mapeamento de status, processamento de transações e referências pendentes, publicação do outbox, consumo do SQS com DLQ, observabilidade e limitações conhecidas.
