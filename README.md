# Distributed Wagering Processor

[![CI](https://github.com/yamferreira/wagering-processor/actions/workflows/ci.yml/badge.svg)](https://github.com/yamferreira/wagering-processor/actions/workflows/ci.yml)

Solução do desafio técnico da Jungle Gaming: um serviço financeiro que processa transações de
apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas por **HTTP** e por **SQS**. Tem saldo
materializado por wallet, ledger append-only, idempotência persistente, Transactional Outbox,
Inbox e processamento de referências fora de ordem. Roda em várias instâncias concorrentes.

- Decisões, garantias do schema, concorrência, mensageria e interpretações da especificação:
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Teste de carga (1 instância × 3 instâncias): [`docs/LOAD-TEST.md`](docs/LOAD-TEST.md)

## Visão geral da arquitetura

```mermaid
flowchart LR
    P(["Provedores"])

    subgraph IN["SQS de entrada"]
        QIN[["wager-transactions.fifo"]]
        DLQ[["wager-transactions-dlq.fifo"]]
    end

    subgraph APP["N instâncias sem estado (papéis em ROLES)"]
        API["api"]
        CON["consumer"]
        PW["pending-worker"]
        PUB["publisher"]
    end

    subgraph PG["PostgreSQL 16"]
        W[("wallets")]
        L[("wallet_ledger_entries")]
        T[("wager_transactions")]
        IB[("inbox_messages")]
        OB[("outbox_messages")]
    end

    QEV[["wagering-events.fifo"]]

    P -- "HTTP POST /wagering/transactions" --> API
    P -- "SendMessage" --> QIN
    QIN -- "long poll" --> CON
    CON -- "erro permanente" --> DLQ
    QIN -. "redrive" .-> DLQ
    API -- "uma transação SQL, lock da wallet" --> PG
    CON -- "a mesma transação, com inbox" --> PG
    PW -- "PENDING_REFERENCE, SKIP LOCKED" --> T
    OB -- "SKIP LOCKED, em lote" --> PUB
    PUB -- "SendMessageBatch" --> QEV
```

Cada instância roda os papéis listados em `ROLES` e não guarda estado em memória: a coordenação é toda
pelo banco. Saldo, ledger, transação, inbox e outbox são gravados na mesma transação SQL, e o evento só
sai para `wagering-events.fifo` depois do commit, pela outbox.

## Versões fixadas

| Componente | Versão | Onde está fixada |
|---|---|---|
| Bun (runtime, package manager, test runner) | **1.3.14** | `package.json` (`packageManager`, `engines`), CI |
| PostgreSQL | **16.15** (`postgres:16.15-alpine`) | `docker-compose.yml`, CI |
| LocalStack (SQS) | **4.14.0** (community, não exige token) | `docker-compose.yml`, CI |
| TypeScript / NestJS / MikroORM | 7.0.2 / 12.3.3 / 7.2.7 | `bun.lock` (`bun install --frozen-lockfile`) |

> O LocalStack `latest` (2026.x) exige `LOCALSTACK_AUTH_TOKEN`. A 4.14.0 é a última imagem community
> que sobe sem conta, e o CI valida nela FIFO, deduplicação, redrive para a DLQ e `ChangeMessageVisibility`.

## Portas

| Serviço | Porta no host | Variável para trocar |
|---|---|---|
| API HTTP | `3000` | `PORT` |
| PostgreSQL | **`55432`** (não 5432, para não colidir com um PostgreSQL local) | `POSTGRES_HOST_PORT` (compose) + `DATABASE_URL` (app) |
| LocalStack (SQS) | `4566` | `LOCALSTACK_HOST_PORT` (compose) + `SQS_ENDPOINT` (app) |

## Setup

Pré-requisitos: **Docker com Docker Compose** e **Bun 1.3.14**. Os defaults da aplicação já apontam
para o compose, então o `.env` é opcional (veja `.env.example`).

### Linux / macOS

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"   # se ainda não tiver o Bun 1.3.14

git clone https://github.com/yamferreira/wagering-processor.git && cd wagering-processor
bun install --frozen-lockfile
docker compose up -d --wait        # PostgreSQL 16.15 em :55432 + LocalStack 4.14.0 em :4566
bun run migration:up               # schema + role de runtime wagering_app (menor privilégio)
bun run sqs:setup                  # cria as 3 filas FIFO (idempotente)
bun run start                      # API + consumidor SQS + publisher da outbox + worker de PENDING_REFERENCE
```

### Windows (PowerShell)

```powershell
iex "& {$(irm https://bun.sh/install.ps1)} -Version 1.3.14"   # se ainda não tiver o Bun 1.3.14

git clone https://github.com/yamferreira/wagering-processor.git; cd wagering-processor
bun install --frozen-lockfile
docker compose up -d --wait
bun run migration:up
bun run sqs:setup
bun run start
```

Pronto quando `curl http://localhost:3000/health/ready` responder `200`.

### Tudo em containers (sem Bun no host)

```bash
docker compose --profile app up -d --build --wait
```

O profile `app` constrói a imagem (`Dockerfile`, `oven/bun:1.3.14`), roda uma vez o serviço `setup`
(migrations + filas) e sobe **3 instâncias** com todos os papéis, em `:3001`, `:3002` e `:3003`, sobre o
mesmo PostgreSQL e o mesmo LocalStack. Para conferir:

```bash
for port in 3001 3002 3003; do curl -s localhost:$port/health/ready; echo; done
```

Os exemplos abaixo funcionam com `API=http://localhost:3001` (ou qualquer uma das três), e `bun run sqs:send`
no host publica na mesma fila. Sem o profile, `docker compose up -d` continua subindo só o PostgreSQL e o
LocalStack, como pedem o fluxo manual e os testes. Para desligar as instâncias e manter a infraestrutura:
`docker compose --profile app rm -sf setup app-1 app-2 app-3`.

### Papéis por processo (`ROLES`)

`bun run start` sobe os quatro papéis. Para escalar cada um separadamente:

```bash
ROLES=api PORT=3001 bun run start                      # Linux/macOS
ROLES=consumer,pending-worker bun run start
```
```powershell
$env:ROLES="publisher"; bun run start                 # Windows
```

Todos os papéis são stateless e coordenam pelo PostgreSQL (lock de linha da wallet, `SKIP LOCKED`,
constraints únicas e inbox), então qualquer número de instâncias pode rodar ao mesmo tempo.

## Testes

Todas as suítes usam **PostgreSQL e LocalStack reais** (o `docker compose` precisa estar no ar), nunca mocks.
Se um dos dois não responder, a primeira suíte que precisar deles para a execução na hora com uma única
mensagem (`Suba os dois com: docker compose up -d --wait`), em vez de um erro de conexão por teste. Os testes
de unidade não dependem deles.

| Comando | O que roda | Tempo (Windows 11, local) | Tempo (CI, Linux) |
|---|---|---|---|
| `bun run typecheck` | `tsc --noEmit` (strict) | ~5 s | ~1 s |
| `bun run test:unit` | 254 testes de domínio, aplicação e workers | ~0,3 s | ~0,1 s |
| `bun run test:integration` | 198 testes: schema/constraints (incl. role de runtime), repositórios, use cases, HTTP, SQS, inbox/DLQ, outbox, worker, observabilidade | ~110 s | ~80 s |
| `bun test` | unidade + integração | ~110 s | — |
| `bun run test:concurrency` | 17 testes com paralelismo real: 50× a mesma aposta, §8, hot wallet, 50 wallets, **3 processos reais**, crash depois do commit e antes do ack, SIGKILL + restart | ~90 s | ~48–57 s |
| `bun run test:all` | `bun test` e depois `test:concurrency` | ~3 min | — |
| `bun run audit:money` | auditoria estática: nenhum `number`/float para dinheiro em `src`, testes e scripts | <1 s | <1 s |
| `bun run test:load` | carga: 1 × 3 instâncias, 8 e 64 clientes, relatório em `reports/` (ver `docs/LOAD-TEST.md`) | ~3 min | ~3 min (job `load`, informativo) |

> **Por que a concorrência fica fora do `bun test` padrão:** juntas, as suítes passam de 3 minutos. O
> `bunfig.toml` ignora `test/concurrency/**` no `bun test` (`pathIgnorePatterns`), e `bun run test:concurrency`
> roda essa pasta explicitamente. Ela sobe processos reais de `src/main.ts`, e o harness mata todos no
> teardown (nenhum órfão, conferido por PID). No CI (Linux), typecheck e as três suítes rodam em etapas
> separadas, mais um smoke que valida o desligamento por SIGTERM real; o job `load` roda a carga e publica o
> relatório como artefato, sem bloquear o merge.

Todo teste de integração ou concorrência termina conferindo o invariante
`wallet.balance == Σ(ledger)` em SQL (`NUMERIC`, nunca `number`).

## Endpoints (exemplos com curl)

Os exemplos usam bash. No Windows, use **Git Bash** ou troque `curl` por `curl.exe` no PowerShell (no
PowerShell, `\` vira `` ` `` para quebrar linha e as aspas do JSON precisam ser escapadas, por isso o Git
Bash é mais simples). As respostas abaixo são reais, capturadas de uma instância local.

```bash
API=http://localhost:3000
```

### Health e métricas (sem autenticação)

```bash
curl -s $API/health/live      # {"status":"ok"}
curl -s $API/health/ready     # 200 {"status":"ready","checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}
                              # 503 {"status":"not_ready","checks":{...,"sqs":{"status":"down","error":"..."}}}
curl -s $API/metrics          # formato Prometheus (wagering_transactions_total, outbox_lag_seconds, ...)
```

### Criar wallet

```bash
curl -s -X POST $API/wallets -H 'Content-Type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
```
```json
201 {"id":"01a1ae1a-8f02-7000-a5b7-6e609a1c2195","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
409 {"error":{"code":"WALLET_ALREADY_EXISTS","message":"Player … already has a BRL wallet"}}
```

```bash
WALLET=01a1ae1a-8f02-7000-a5b7-6e609a1c2195          # o "id" da resposta
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
```

### Submeter transação (`Idempotency-Key` obrigatório)

```bash
curl -s -X POST $API/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a", "externalTransactionId": "transaction-123",
  "playerId": "'$PLAYER'", "walletId": "'$WALLET'",
  "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
}'
```
| Situação | Status | Corpo |
|---|---|---|
| Nova, processada | `201` | `{"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}` |
| Mesma key e mesmo payload (replay) | `200` | o mesmo corpo, com `"idempotentReplay":true` |
| Mesma key, payload diferente | `409` | `{"error":{"code":"IDEMPOTENCY_KEY_REUSED","existingTransactionId":"…"}}` |
| Referência ainda não chegou (ex.: ROLLBACK antes da BET) | `202` | `{"status":"PENDING_REFERENCE","balance":null,…}` |
| Regra de negócio (ex.: saldo insuficiente) | `422` | `{"error":{"code":"INSUFFICIENT_FUNDS","failureCode":"INSUFFICIENT_FUNDS","providerAction":"GIVE_UP","status":"REJECTED","balance":{…},…}}` |
| Payload inválido (ex.: `"amount":"25"`) | `400` | `{"error":{"code":"INVALID_MONEY","message":"…exactly 2 decimal places"}}` |
| Falha transitória (banco fora, `lock_timeout`) | `503` + `Retry-After` | `{"error":{"code":"TRANSIENT_INFRASTRUCTURE_ERROR","reason":"LOCK_TIMEOUT"}}` → reenviar com a mesma key |

Outros tipos: `"kind": "WIN"` (crédito, `referenceExternalTransactionId` opcional), `"LOSS"` (sem efeito no
saldo, `"amount":"0.00"` permitido), `"REFUND"` e `"ROLLBACK"` (exigem `referenceExternalTransactionId`).
Por exemplo, um WIN da aposta acima:

```bash
curl -s -X POST $API/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:transaction-124' -d '{
  "providerId": "provider-a", "externalTransactionId": "transaction-124",
  "playerId": "'$PLAYER'", "walletId": "'$WALLET'", "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "WIN", "referenceExternalTransactionId": "transaction-123",
  "money": { "amount": "40.00", "currency": "BRL" }
}'
# 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"1015.00","currency":"BRL"},"idempotentReplay":false}
```

### Consultas

```bash
curl -s $API/wallets/$WALLET                                   # saldo e version
curl -s "$API/wallets/$WALLET/ledger?limit=2"                  # {"walletId","items":[…],"nextCursor"}
curl -s "$API/wallets/$WALLET/ledger?limit=2&cursor=<nextCursor>"
curl -s $API/wagering/transactions/<transactionId>             # por id interno
curl -s $API/providers/provider-a/wagering/transactions/transaction-123   # por id externo
```

### Reconciliação

```bash
curl -s -X POST $API/wallets/$WALLET/reconciliation
```
```json
{"walletId":"…","storedBalance":{"amount":"1015.00","currency":"BRL"},"calculatedBalance":{"amount":"1015.00","currency":"BRL"},
 "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":3,
 "details":{"latestEntryBalanceMatches":true,"latestEntryVersionMatches":true}}
```
Uma divergência responde `consistent: false` com a `difference`, gera log de erro e incrementa
`reconciliation_divergences_total`. O saldo **nunca** é corrigido automaticamente.

### Entrada por SQS

`docs/examples/wager-transaction-requested.json` é o envelope da §10. O script troca campos de `data` e
gera um `messageId` novo:

```bash
bun run sqs:send docs/examples/wager-transaction-requested.json walletId=$WALLET playerId=$PLAYER \
  externalTransactionId=transaction-500 idempotencyKey=provider-a:transaction-500
```

O consumidor aplica o mesmo use case da HTTP. Mensagens inválidas vão direto para
`wager-transactions-dlq.fifo`; falhas transitórias são reentregues com backoff; os eventos de integração
saem em `wagering-events.fifo` via outbox.

## Observabilidade

- **Logs:** JSON em stdout (pino), com `correlationId` (`X-Correlation-Id` aceito e devolvido),
  `messageId`, `transactionId`, `walletId` e `providerId`. Valores monetários e payloads nunca são
  registrados (redaction testada). `LOG_LEVEL=debug` mostra também health e reavaliações de pendências.
- **Métricas:** `GET /metrics` (transações por status, duplicatas, retries, DLQ, conflitos/espera de lock,
  outbox lag, latência e divergências). Detalhes em `docs/ARCHITECTURE.md` §11.

## Configuração principal

| Variável | Default | Para quê |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering_app:wagering_app@localhost:55432/wagering` | conexão do serviço: role de menor privilégio criado pelas migrations (sem superuser, sem posse de tabelas, ledger só SELECT/INSERT) |
| `MIGRATION_DATABASE_URL` | `postgres://wagering:wagering@localhost:55432/wagering` | dono do schema, usado só por `migration:up`/`down` |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack/SQS |
| `ROLES` | `api,consumer,publisher,pending-worker` | papéis deste processo |
| `DB_LOCK_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | `5000` / `10000` | limites por transação (estourou → 503) |
| `SQS_MAX_RECEIVES` / `SQS_REDRIVE_MAX_RECEIVES` | `5` / `6` | tentativas antes da DLQ (aplicação / rede de segurança do broker) |
| `PENDING_REF_MAX_ATTEMPTS` / `_BASE_MS` / `_CAP_MS` | `10` / `2000` / `300000` | backoff de PENDING_REFERENCE (≈18 min antes de `REFERENCE_NOT_FOUND`) |
| `SUPPORTED_CURRENCIES` | `BRL,USD,EUR` | moedas aceitas (escala 2) |
| `LOG_LEVEL` | `info` | nível do pino |

A lista completa, com validação, está em `src/infrastructure/config/config.ts`.

## Problemas comuns

- **`/health/ready` responde 503 com `sqs: "The specified queue does not exist."`**: o LocalStack não
  persiste estado, e recriar o container apaga as filas. Rode `bun run sqs:setup` de novo.
- **Porta 55432 ocupada:** `POSTGRES_HOST_PORT=55433 docker compose up -d` e troque a porta em
  `DATABASE_URL` e `MIGRATION_DATABASE_URL`.
- **`password authentication failed for user "wagering_app"`:** o role do serviço é criado pela migration.
  Rode `bun run migration:up` antes do `start`.
- **Ctrl+C / SIGTERM:** o processo para de receber, termina as mensagens em andamento (ou devolve a
  visibilidade delas) e fecha o pool. No Windows, um processo filho criado pelo Bun recebe `kill("SIGTERM")`
  como término imediato, por isso o harness de testes usa IPC lá. O CI valida o SIGTERM real em Linux.

## Uso de IA

As decisões de arquitetura, as interpretações da especificação e os trade-offs foram definidos e revisados
por mim. A IA foi usada como assistente de desenvolvimento e de revisão. As decisões de arquitetura e as
regras de negócio foram validadas por testes contra PostgreSQL e SQS reais (LocalStack), por testes de concorrência
com múltiplos processos, pelo CI em Linux e por uma revisão independente (`docs/ARCHITECTURE.md`, seção 13).

## Estrutura

```
src/domain           TypeScript puro: Money, Wallet, WalletLedgerEntry, WagerTransaction, decide(), eventos
src/application      use cases e portas (repositórios, transação, publisher, métricas, logger, clock, ids)
src/infrastructure   MikroORM + migrations, Nest (HTTP), SQS (consumidor, publisher), workers, observabilidade
test/unit            domínio, aplicação e workers, sem I/O
test/integration     PostgreSQL + LocalStack reais
test/concurrency     paralelismo real e processos reais (crash, restart, 3 instâncias)
test/load            teste de carga
scripts/             migrations, filas, envio de mensagem de exemplo
Dockerfile           imagem do serviço (profile app do docker compose)
```
