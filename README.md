# Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming. A especificação está em `docs/CHALLENGE.md`,
o plano em `docs/PLAN.md` e as decisões em `docs/ARCHITECTURE.md`.

## Pré-requisitos

- Bun 1.3+
- Docker com Docker Compose

## Setup rápido

```bash
bun install
docker compose up -d          # PostgreSQL 16 (porta 55432) + LocalStack 4.14.0 (porta 4566)
bun run migration:up
bun run sqs:setup
bun run start
```

## Comandos

| Comando | O que faz |
|---|---|
| `docker compose up -d` | sobe PostgreSQL e LocalStack |
| `bun run migration:up` / `migration:down` | aplica ou reverte migrations |
| `bun run sqs:setup` | cria as filas (idempotente) |
| `bun run start` | API + workers |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | todas as suítes (requer o docker compose no ar) |
| `bun run test:unit` / `test:integration` / `test:concurrency` | suítes separadas |

_(README completo na T25.)_
