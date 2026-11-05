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

### 4.1 Money (T02)

- **Representação:** inteiro de unidades menores (centavos) como `bigint`, escala fixa de 2
  casas e moeda ISO-4217 (`^[A-Z]{3}$`). Nenhuma operação passa por `number`.
- **Contrato de entrada estrito (A1):** `^(0|[1-9]\d{0,17})\.\d{2}$`. Exatamente 2 casas, sem sinal
  e sem zeros à esquerda; no máximo 18 dígitos inteiros, para caber em `NUMERIC(20,2)`. São rejeitados
  `"25"`, `"25.5"`, `"1.005"` (não há arredondamento: um valor ambíguo é recusado, nunca ajustado),
  `"1e2"`, `"NaN"`, `"Infinity"`, `"-1.00"`, `"+1.00"`, `""`. Por isso a mesma quantia tem uma
  única forma textual, e o `payloadHash` não depende de normalização.
- **Negativos:** `Money.from` (contrato) recusa negativos. Internamente, `subtract`/`negate` podem
  produzir negativos (ex.: verificar se um débito deixaria o saldo abaixo de zero), sempre
  formatados com escala fixa (`"-5.05"`).
- **Overflow:** qualquer resultado fora de `±(10^20 − 1)` centavos lança `MoneyOverflowError`,
  e nunca é truncado.
- **Moedas:** o domínio valida só o formato. A allowlist (`SUPPORTED_CURRENCIES`, default
  `BRL,USD,EUR`, A3) é aplicada na borda (HTTP/SQS). Moedas com 0 ou 3 casas (JPY, KWD) estão fora de escopo.
- **Imutabilidade:** `Object.freeze` no construtor; toda operação devolve uma nova instância.
- **Erros:** `InvalidMoneyError`, `InvalidCurrencyError`, `CurrencyMismatchError`,
  `MoneyOverflowError`, todos subclasses de `DomainError`, com `code` estável.

### 4.2 Taxonomia de `failureCode` (T03, §7.2)

Todo código é **terminal para a sua idempotency key**: reenviar a mesma requisição devolve o
mesmo resultado (replay). Para tentar de novo após corrigir algo, o provedor precisa de uma key nova.
Falhas transitórias de infraestrutura **não** são `failureCode`: elas viram HTTP 503 ou retry na SQS,
e o reenvio com a mesma key é seguro.

| Código | Quando | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | `GIVE_UP` |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN/REFUND deixaria o saldo negativo | `CONTACT_OPERATOR` |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | `FIX_PAYLOAD` |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é o dono da `walletId` | `FIX_PAYLOAD` |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do orçamento de PENDING_REFERENCE | `FIX_PAYLOAD` (enviar a referência e reenviar com key nova) |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada (`details.field`) | `FIX_PAYLOAD` |
| `REFERENCE_KIND_NOT_ALLOWED` | REFUND de não-BET, ROLLBACK de LOSS/ROLLBACK/OPENING, WIN/LOSS referenciando não-BET | `FIX_PAYLOAD` |
| `REFERENCE_NOT_PROCESSED` | referência terminou REJECTED/FAILED | `GIVE_UP` |
| `REFERENCE_AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | `FIX_PAYLOAD` |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida (ou WIN sobre BET revertida, A6) | `GIVE_UP` |
| `INTERNAL_INVARIANT_VIOLATION` | erro permanente interno após o aceite (status FAILED, A16) | `CONTACT_OPERATOR` |

O saldo insuficiente numa BET e numa reversão têm códigos e ações diferentes. A primeira é rotina;
a segunda indica um estado contábil que precisa de intervenção (§7).

> Desvio menor do PLAN (T03): o plano previa a ação `RETRY`. Ela não existe porque nenhum
> `failureCode` é retentável com a mesma key; o retry fica restrito a 503 e transientes.

`WALLET_NOT_FOUND` (A9) não é `failureCode`: a transação não é persistida (FK) e a resposta é 404.

### 4.3 Wallet e WalletLedgerEntry (T04)

- **Única via de mudança de saldo:** `debit`/`credit` (e `move(direction)`, usado pelas regras).
  Cada chamada devolve o `WalletLedgerEntry` criado no mesmo passo. A entrada é construída e
  validada **antes** de o agregado mudar, então uma entrada inválida não deixa o saldo alterado.
- **`version`:** começa em 1. O crédito de abertura **não** incrementa a versão: a entrada de
  abertura leva `walletVersion = 1`, como no exemplo da §9, que mostra `version: 1` com saldo 1000.00.
  Cada movimento posterior incrementa a versão em exatamente 1, e a entrada registra a versão
  resultante. Daí vale a relação `version == nº de lançamentos` (ou `+1` se a wallet abriu com
  saldo zero), que o schema reforça com `UNIQUE(wallet_id, wallet_version)` (T09).
- **`walletVersion` no lançamento:** campo adicional ao esqueleto da §6.4. Serve de chave de
  ordenação estável do ledger (cursor, A20) e de elo de encadeamento (`balance_before` da versão
  *n* = `balance_after` da versão *n−1*).
- **Guardas:** `debit` lança `InsufficientFundsError` sem alterar estado. O caminho de negócio
  verifica `canDebit` antes (T06) e transforma isso em `INSUFFICIENT_FUNDS` /
  `REVERSAL_INSUFFICIENT_FUNDS`. Movimento zero ou de outra moeda é rejeitado.
- **Abertura:** `Wallet.open` recebe os ids da transação OPENING e do lançamento (o domínio não
  gera ids). Com saldo inicial zero não há OPENING nem lançamento.
- **Imutabilidade do lançamento:** campos `readonly` + `Object.freeze`, e datas copiadas
  defensivamente. `create` valida a aritmética, valores positivos, uma única moeda, saldos não negativos e `walletVersion ≥ 1`.

### 4.4 WagerTransaction: máquina de estados (T05)

```
            ┌──────────────► PROCESSED  (terminal)
            │
 PENDING ───┼──────────────► REJECTED   (terminal)
   │        │
   │        └──────────────► FAILED     (terminal)
   │
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              │   ▲
              └───┘ reagendamento (attempts + 1)
```

- Tabela explícita em `VALID_TRANSITIONS` (`src/domain/wager/kinds.ts`). Sair de um estado
  terminal lança `InvalidTransactionStateError`, que é erro de programação e não caminho de negócio.
- **PENDING (A15)** é o estado inicial em memória. Na mesma transação SQL a transação vai para
  PROCESSED, REJECTED ou PENDING_REFERENCE. Nenhum fluxo commita PENDING.
- **`processedAt`** é preenchido ao atingir qualquer estado terminal: é o instante da decisão.
- **`resultingBalance`** guarda o saldo observado na decisão (pós-movimento em PROCESSED,
  saldo inalterado em REJECTED). É o que o replay idempotente devolve (§7).
- **`referenceAttempts` / `nextReferenceAttemptAt`:** controle do worker de PENDING_REFERENCE.
  A primeira marcação agenda sem contar tentativa; cada reagendamento conta uma.
- **Validação em `create` (A2, A5, A8):**
  - OPENING é proibido (existe `createOpening`, interno);
  - REFUND e ROLLBACK exigem referência, BET não pode ter;
  - autorreferência é proibida;
  - `providerId = "internal"` é reservado;
  - valor > 0, exceto LOSS (≥ 0);
  - campos de identificação não podem ser vazios.
- **`ledgerDirectionFor`:** BET → DEBIT; WIN, REFUND, OPENING → CREDIT; ROLLBACK → inverso da
  direção da referência, que só pode ser BET, WIN ou REFUND; LOSS → sem lançamento.
- **OPENING (A17):** `providerId = "internal"`, `externalTransactionId = "opening:{walletId}"`,
  `idempotencyKey = "internal:opening:{walletId}"`, sem `roundId`/`gameId`, criada já PROCESSED.

### 4.5 Regras de negócio: `decide()` + `applyDecision()` (T06, §7)

`decide(tx, wallet, lookup)` é uma função pura. O use case a chama **com o lock da wallet
adquirido**, então `wallet` e `lookup` refletem o último estado commitado e não mudam durante
a decisão. A saída é uma das variantes `APPLY(direction)`, `RECORD_ONLY` (LOSS), `REJECT(code)` ou
`PENDING_REFERENCE`. `applyDecision` é o único ponto em que uma transação de aposta move o
saldo: saldo, lançamento e status mudam juntos.

Ordem de avaliação (a primeira regra que falha decide):

1. `playerId` ≠ dono da wallet → `WALLET_PLAYER_MISMATCH`; moeda ≠ moeda da wallet → `CURRENCY_MISMATCH`.
2. Se há referência:
   - não encontrada → `PENDING_REFERENCE`;
   - tipo não permitido → `REFERENCE_KIND_NOT_ALLOWED`. Permitidos: WIN/LOSS/REFUND → BET; ROLLBACK → BET, WIN, REFUND;
   - provider, player, wallet, moeda ou rodada divergentes → `REFERENCE_MISMATCH` + `details.field`;
   - referência ainda em PENDING/PENDING_REFERENCE → `PENDING_REFERENCE` (A7); REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`;
   - reversão com valor diferente → `REFERENCE_AMOUNT_MISMATCH`;
   - referência já revertida → `REFERENCE_ALREADY_REVERSED`. Vale para reversões (A4) e para WIN/LOSS sobre BET revertida (A6).
3. LOSS → `RECORD_ONLY`, sem lançamento e sem incrementar a versão.
4. Direção DEBIT sem saldo: BET → `INSUFFICIENT_FUNDS`; ROLLBACK → `REVERSAL_INSUFFICIENT_FUNDS`.
5. Caso contrário → `APPLY`.

**Risco documentado (A6):** REFUND ou ROLLBACK de uma BET que já tem WIN é **permitido**, conforme
a spec literal. O provedor deve fazer o ROLLBACK do WIN antes. Bloquear isso exigiria uma regra
não prevista na especificação, que só pegaria WINs com referência.

**PENDING_REFERENCE com backoff (§7.1, A25):** `ReferenceRetryPolicy`, de domínio e pura:
`delay(n) = min(base · 2ⁿ, cap)`. O default é 10 retries, base 2s e cap 5 min, o que dá
2+4+8+…+256+300+300 = 1110 s (≈ 18,5 min) até `REJECTED / REFERENCE_NOT_FOUND`. A primeira
marcação agenda sem contar tentativa; o retry nº `maxAttempts` que ainda não encontra a
referência rejeita. Os parâmetros são configuráveis por env (T16).

**Justificativa do limite:** entregas fora de ordem entre provedores costumam se resolver em
segundos ou minutos. Esperar 18 min cobre filas atrasadas e retries do provedor sem manter
transações pendentes indefinidamente. Além disso, o wake-up (T16) resolve na hora quando a
referência chega.

### 4.6 Eventos de integração, Outbox e Inbox (T07, §6.5, §11)

- **Envelope:** a classe abstrata `IntegrationEvent<T>` tem uma subclasse por evento, e
  `eventType`/`version` são campos da subclasse (mais `static TYPE` para os consumidores). `data`
  passa por um round-trip JSON e fica congelado: o payload é JSON estável, só com `MoneyProps` (string).
- **Eventos:**

  | Evento | `aggregateId` | Quando |
  |---|---|---|
  | `WagerTransactionProcessed` | transactionId | qualquer transação aplicada, inclusive LOSS e OPENING |
  | `WagerTransactionRejected` | transactionId | rejeição de negócio (inclui `REFERENCE_NOT_FOUND` por esgotamento) |
  | `WalletBalanceChanged` | walletId | um por lançamento no ledger, ou seja, só quando o saldo muda |
  | `WagerTransactionPendingReference` | transactionId | referência ausente (primeira marcação) |

  Todos carregam `walletId` em `data`, que é a chave de agrupamento na fila de eventos (A24).
- **Outbox:** `OutboxMessage.enqueue(event)` usa `id = eventId`, a chave de deduplicação dos
  consumidores. Mensagem nova nasce devida (`nextAttemptAt = occurredAt`). `scheduleRetry` aplica
  backoff exponencial de 1s até o cap de 60s, com até 20% de jitter injetável, **sem limite de
  tentativas**, para que um evento confirmado nunca se perca (A29); o alarme vem de `outbox_lag_seconds`.
  `markPublished` é idempotente: uma publicação duplicada mantém o primeiro timestamp.
- **Inbox:** `InboxMessage.receive` guarda `payloadHash` para detectar o mesmo `messageId` com
  conteúdo diferente (permanente → DLQ, A27). `markProcessed` só pode ser chamado uma vez.

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
