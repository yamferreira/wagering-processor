# ARCHITECTURE.md — Distributed Wagering Processor

> Documento vivo: cada tarefa do `docs/PLAN.md` registra aqui as decisões que tomou.
> As interpretações da especificação seguem a numeração `A1…A32` do PLAN.md.

## 1. Visão geral

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
recebidas por HTTP e por SQS, com saldo materializado por wallet, ledger append-only,
idempotência persistente, Transactional Outbox e Inbox.

## 2. Stack e versões

| Item | Escolha | Observação |
|---|---|---|
| Runtime / PM / testes | Bun 1.3 | `bun test` como runner |
| Linguagem | TypeScript 7 (strict) | só para typecheck (`tsc --noEmit`); o Bun transpila em runtime |
| Framework | NestJS 12 (platform-express) | só em `src/infrastructure/http` |
| ORM | MikroORM 7 (driver PostgreSQL) | `EntitySchema`, sem decorators no domínio |
| Banco | PostgreSQL 16 | |
| Mensageria | AWS SQS via LocalStack **4.14.0** | ver 2.1 |
| Validação de contrato | zod 4 | schemas estritos nos DTOs HTTP e no envelope SQS |
| Logs / métricas | pino / prom-client | |

### 2.1 Decisões de ambiente (T01)

- **LocalStack fixado em `4.14.0`.** A imagem `localstack/localstack:latest` (2026.x) exige
  `LOCALSTACK_AUTH_TOKEN` e encerra com "License activation failed". A 4.14.0 é a última
  community que sobe sem conta. Assim, quem avalia roda `docker compose up` sem precisar de credenciais.
- **PostgreSQL na porta 55432 do host.** A 5432 costuma estar ocupada por instalações locais.
  A porta é configurável via `POSTGRES_HOST_PORT`.
- **NestJS + decorators no Bun validados.** A injeção de dependência por construtor funciona com
  `experimentalDecorators` + `emitDecoratorMetadata`: o transpiler do Bun emite `design:paramtypes`.
  O TS 7 faz o typecheck desses decorators sem erro, então nenhum fallback foi necessário.

## 3. Camadas (hexagonal)

- `src/domain`: TypeScript puro, sem Nest, sem MikroORM e sem decorators.
- `src/application`: use cases e portas (repositórios, publisher, clock, id generator, transaction runner).
- `src/infrastructure`: MikroORM, SQS, HTTP (Nest), observabilidade, auth.

## 4. Modelo de domínio

_(preenchido a partir da T02)_

## 5. Persistência e schema

_(T09/T10)_

## 6. Concorrência

_(T10)_

## 7. Idempotência

_(T08/T11)_

## 8. API HTTP e mapeamento de status

_(T12)_

## 9. Mensageria: inbox, outbox, PENDING_REFERENCE

_(dia 2)_

## 10. Autenticação

_(T12)_

## 11. Observabilidade

_(dia 3)_

## 12. Trade-offs e limitações

_(contínuo)_
