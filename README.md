# Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming. As decisões de arquitetura e as interpretações
da especificação estão em `docs/ARCHITECTURE.md`.

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
| `bun test` | unidade + integração (~1,5 min; requer o docker compose no ar) |
| `bun run test:concurrency` | concorrência: paralelismo real, 3 processos, crash e restart (~1,5 min) |
| `bun run test:all` | tudo: `bun test` e depois `test:concurrency` |
| `bun run test:unit` / `test:integration` | suítes separadas |

> **Por que a concorrência fica fora do `bun test` padrão:** juntas, as suítes passam de 3 minutos. O
> `bunfig.toml` ignora `test/concurrency/**` no `bun test` (`pathIgnorePatterns`), e
> `bun run test:concurrency` roda essa pasta explicitamente. Ela sobe processos reais de `src/main.ts`,
> e o harness garante que nenhum fica órfão.

_(README completo na T25.)_
