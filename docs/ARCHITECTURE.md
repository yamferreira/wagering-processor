# ARCHITECTURE.md — Distributed Wagering Processor

> Documento vivo: cada tarefa de implementação (T01…T27) registra aqui as decisões que tomou.
> As interpretações da especificação (`A1…A32`) estão no [Apêndice A](#apêndice-a--interpretações-da-especificação-a1a32).

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

### 5.1 Migrations (T09)

- Uma migration MikroORM em SQL explícito (`Migration20261105000000_initial`), com `up` e `down`
  reversíveis, registrada numa lista explícita (`migrationsList`) e não por glob de arquivos.
- O migrator roda por script (`bun run migration:up|down` → `scripts/migrate.ts` →
  `orm.migrator.up()/down()`), sem a CLI do MikroORM. Validado no Bun sem fallback.
- Snapshots desligados, porque o schema é escrito à mão: constraints e triggers não são
  expressáveis via `EntitySchema`. `allOrNothing` + `transactional` fazem um lote parcial falhar inteiro.
- Testes: `up → down → up → up (no-op)` num database vazio.

### 5.2 Garantias no schema (§5, §6)

| Garantia | Objeto no banco |
|---|---|
| Dinheiro exato | `NUMERIC(20,2)` + `CHAR(3)` (nunca float) |
| 1 wallet por player + moeda | `wallets_player_currency_uq` |
| Saldo ≥ 0 | `CHECK (balance >= 0)` em wallets; `balance_before/after >= 0` no ledger; `resulting_balance >= 0` |
| Idempotência | `wager_tx_idempotency_key_uq`, `wager_tx_provider_external_uq` |
| Reversão única (A4) | índice único parcial `wager_tx_single_reversal_uq (reference_transaction_id) WHERE kind IN (REFUND, ROLLBACK) AND status = PROCESSED`. Rejeições não ocupam a vaga |
| Referência na mesma wallet | FK composta `(reference_transaction_id, wallet_id) → wager_transactions(id, wallet_id)` |
| ≤ 1 lançamento por transação | `ledger_transaction_uq (transaction_id)` |
| Lançamento da mesma wallet e moeda | FKs compostas `(transaction_id, wallet_id)` e `(wallet_id, currency)` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| Ledger append-only | triggers `BEFORE UPDATE/DELETE` (por linha) e `BEFORE TRUNCATE` → `23001` |
| Encadeamento do ledger | trigger `ledger_check_chain`: versão = anterior + 1 e `balance_before` = `balance_after` anterior (ou 0 na primeira entrada, versão 1 ou 2) |
| Saldo ⇔ ledger | constraint triggers **deferred** `wallet_check_ledger` e `ledger_check_wallet`: no commit, `wallets.version/balance` = versão e `balance_after` da última entrada. Sem entradas, exige versão 1 e saldo 0. Cobre "toda alteração de saldo tem lançamento e vice-versa" |
| Lost update | `UNIQUE (wallet_id, wallet_version)`, além do lock e do `WHERE version = ?` (T10) |
| Transação terminal imutável | trigger `wager_tx_guard_update`: nada muda após PROCESSED/REJECTED/FAILED, colunas de negócio nunca mudam e não há volta para PENDING. DELETE/TRUNCATE proibidos |
| Coerência de status | CHECKs: `failure_code` ⇔ REJECTED/FAILED; PROCESSED exige `processed_at` + `resulting_balance`; PENDING_REFERENCE exige `next_reference_attempt_at` |
| Regras por kind | REFUND/ROLLBACK exigem referência; BET/OPENING não podem ter; valor > 0 exceto LOSS; `provider_id = 'internal'` ⇔ OPENING; round/game obrigatórios exceto OPENING |
| Outbox/Inbox | PK da outbox = `eventId`; conteúdo imutável e publicação definitiva (trigger). Inbox com PK `(consumer_name, message_id)` e imutável |

`resulting_balance_currency` existe porque o saldo observado é na moeda da **wallet**, que numa
rejeição `CURRENCY_MISMATCH` difere da moeda da operação.

**Custo dos triggers deferred:** dois lookups indexados por `(wallet_id, wallet_version)` por
commit que toca a wallet. É aceito em troca da garantia, no próprio banco, de que saldo e
ledger não divergem mesmo diante de um bug na aplicação ou de SQL manual. Só um superuser que
desabilite triggers consegue burlar isso, e a reconciliação detecta (T23).

### 5.3 Infraestrutura de teste

Há um database template migrado por processo de teste (`wagering_test_tpl_<pid>`), clonado com
`CREATE DATABASE … TEMPLATE` para cada arquivo de teste. Templates de processos mortos são
removidos na inicialização seguinte. `assertLedgerInvariant` compara tudo em SQL (`NUMERIC`), nunca
em `number`, e tem um teste negativo que prova que detecta divergências.

### 5.4 Mapeamento MikroORM (T10)

- **Por que MikroORM:** `em.transactional()` com escopo explícito, `LockMode.PESSIMISTIC_WRITE`
  e `EntitySchema`, que mapeia classes simples sem decorators e mantém o domínio puro.
- **Records + mappers:** cada tabela tem uma classe de persistência (`WalletRecord`, …) mapeada por
  `EntitySchema`. Os mappers convertem para os agregados via `rehydrate` e, na volta, para records.
  O domínio não conhece o ORM.
- **Money:** colunas `NUMERIC(20,2)` mapeadas como `decimal`. O driver devolve **string**
  (`"25.00"`), verificado em teste, e o mapper reconstrói com `Money.from` (que revalida o formato)
  mais a coluna `currency`. Na escrita vai `money.amount` (string). Nunca há conversão para `number`.
- **Operações nativas em vez de flush implícito:** os repositórios usam `em.insert`,
  `em.nativeUpdate` e `em.find` (com `disableIdentityMap`) dentro de `em.transactional()`. A ordem do
  SQL fica explícita e auditável (transação → lançamento → wallet → outbox), sem depender do
  change-set do Unit of Work. Também nunca existe entidade gerenciada "suja" que o commit possa gravar
  sem querer. O Unit of Work do MikroORM continua demarcando a transação (fork por unidade de trabalho).
- **`TransactionRunner` (porta):** `run(work)` abre um fork novo e uma transação READ COMMITTED,
  e define `lock_timeout` e `statement_timeout` via `set_config(…, true)` (valem só para essa
  transação). Erros do driver são traduzidos (`db-errors.ts`):

  | SQLSTATE / condição | Erro de aplicação | Tratamento |
  |---|---|---|
  | 23505 | `UniqueViolationError(constraint)` | o use case decide (replay / 409) |
  | 40P01 deadlock, 40001 serialization, version mismatch | `TransientInfrastructureError` | até `DB_TX_MAX_RETRIES` (3) retries com backoff curto **re-executando a unidade inteira**; depois, 503 |
  | 55P03 lock_timeout, 57014 statement_timeout, 08xxx/57P0x/53300, ECONNREFUSED… | `TransientInfrastructureError` | sem retry local → 503 / retry da SQS |
  | demais (ex.: 23514 CHECK) | erro original | permanente → FAILED / 500 (A16) |

  Como o retry re-executa a função inteira, ela relê tudo do banco e não depende de estado externo mutável.
- **`read(work)`:** leituras sem transação (cada statement vê o último commit).

## 6. Concorrência

### 6.1 Estratégia (T10, §8)

**Lock pessimista por linha de wallet** (`SELECT … FOR UPDATE` via
`LockMode.PESSIMISTIC_WRITE`) dentro de `em.transactional()`, com mais duas barreiras:

1. `UPDATE wallets … WHERE id = ? AND version = ?`. Se afetar 0 linhas, lança
   `ConcurrencyConflictError`. Nunca deveria acontecer sob o lock: é a defesa contra lost update
   caso alguém escreva sem o lock.
2. `CHECK (balance >= 0)`, `UNIQUE (wallet_id, wallet_version)` e os triggers deferred saldo ⇔
   ledger (§5.2), que são a última linha de defesa no banco.

**Por que pessimista e não otimista:** wallets "quentes" (um jogador com muitas apostas por
segundo, ou rodadas de slot em sequência) com optimistic locking geram uma tempestade de retries:
N requisições concorrentes produzem N−1 conflitos e retries a cada rodada, com latência de cauda
imprevisível. Com `FOR UPDATE`, as requisições da mesma wallet fazem fila no próprio PostgreSQL,
cada uma lê o saldo já commitado pela anterior e decide uma vez. Não há read → calculate →
update sem lock.

**Sem lock global:** o lock é só da linha da wallet. Wallets diferentes rodam em paralelo,
provado por teste determinístico: com a wallet X travada, a Y faz commit e a X expira por `lock_timeout`.

**Limites:** `lock_timeout = 5s` (`DB_LOCK_TIMEOUT_MS`) evita filas infinitas atrás de uma
transação travada; ao estourar, a requisição recebe 503 e pode ser reenviada com a mesma key.
Transações curtas (sem I/O externo dentro do lock, já que a publicação é via outbox) mantêm o tempo de lock em milissegundos.

**Ordem global de locks:** wallet primeiro, depois linhas de `wager_transactions`. Nenhum fluxo
trava duas wallets (a referência pertence à mesma wallet, garantido por FK composta), então não
existe deadlock entre wallets.

## 7. Idempotência

### 7.1 Algoritmo do `payloadHash` (T08, §9, A14)

1. **Subconjunto de negócio**, selecionado explicitamente: `providerId`, `externalTransactionId`,
   `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e
   `referenceExternalTransactionId` (omitido quando ausente). Não entram: header
   `Idempotency-Key`, `messageId`, `occurredAt`, `type`, `correlationId` nem qualquer metadado de transporte.
2. **JSON canônico:** chaves ordenadas recursivamente (ordem de code unit UTF-16, a de
   `Array.prototype.sort`), sem espaços, propriedades `undefined` omitidas, strings escapadas como
   em `JSON.stringify`. Valores sem forma JSON estável (bigint, NaN, Infinity, funções) são rejeitados.
3. **SHA-256** do texto UTF-8, em hexadecimal minúsculo (64 caracteres).

Como `amount` tem formato único (A1), a mesma quantia sempre produz o mesmo texto. HTTP e SQS
geram o mesmo hash, então o replay funciona entre canais. Um vetor fixo (o exemplo da §9, com o hash
calculado de forma independente via `sha256sum`) trava o algoritmo em teste.

### 7.2 Regra de decisão (domínio)

`evaluateIdempotency(existing, { idempotencyKey, payloadHash })`:

| Situação | Resultado |
|---|---|
| mesma key, mesmo hash | `REPLAY` da transação original |
| mesma key, hash diferente | `CONFLICT / IDEMPOTENCY_KEY_REUSED` → 409 |
| mesmo `(providerId, externalTransactionId)` com outra key | `CONFLICT / EXTERNAL_TRANSACTION_CONFLICT` → 409 (A13) |

A garantia vem do banco (`UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`,
T09). Essa função só interpreta a colisão.

### 7.3 Fluxo de `SubmitWagerTransaction` (T11)

O mesmo use case atende HTTP e SQS (§10):

1. **Validação antes do banco:** `Money.from` (contrato estrito), moeda suportada (A3), kind
   externo (OPENING proibido), `WagerTransaction.create` (regras estruturais, A8) e `payloadHash`.
   Erros aqui são 400 e nada é gravado.
2. **Fast path sem lock:** busca pela idempotency key e, em seguida, pelo `(providerId, externalTransactionId)`.
   Se existir, faz replay ou devolve conflito (§7.2). É o caminho comum dos reenvios do provedor.
3. **Unidade de trabalho**, uma transação SQL:
   1. `lockById(walletId)` (`FOR UPDATE`). Wallet inexistente gera `NotFoundError` e nada é gravado (A9);
   2. **re-checagem** da idempotência sob o lock. Pedidos concorrentes com a mesma key na mesma
      wallet fazem fila aqui, e o segundo encontra o primeiro já commitado e faz replay;
   3. resolução da referência por `(providerId, referenceExternalTransactionId)` + `isReversed`;
   4. `decide` → `applyDecision` (§4.5);
   5. INSERT da transação → INSERT do lançamento → `UPDATE wallets … WHERE version = ?` → INSERT dos
      eventos na outbox. Tudo commita junto ou nada commita.
4. **Corrida que escapa das checagens** (a mesma key em wallets diferentes, que não compartilham
   lock): o segundo INSERT espera o primeiro no índice único e recebe 23505. O use case relê o
   vencedor e devolve replay ou conflito. O banco decide; a aplicação só interpreta.
5. **Erros:**

   | Situação | Resultado | Gravado? |
   |---|---|---|
   | validação | `ValidationError` / `InvalidMoneyError` → 400 | não |
   | wallet inexistente | `NotFoundError` → 404 | não |
   | conflito de idempotência | `IdempotencyConflictError` → 409 | não |
   | regra de negócio | transação REJECTED + `failureCode` → 422 | sim (consome a key) |
   | transitório (lock_timeout, conexão, deadlock esgotado) | `TransientInfrastructureError` → 503 | não (rollback) |
   | erro interno permanente (bug, CHECK inesperado) | `InternalProcessingError` → 500; transação gravada como **FAILED** numa transação separada (best effort, A16) | sim |
   | falha injetada / morte do processo | rollback total | não |

**Atomicidade comprovada em teste:** falhas injetadas após o INSERT da transação, após o
lançamento e antes da outbox não deixam nada gravado (nem transação, nem lançamento, nem saldo,
nem evento), e o retry aplica exatamente uma vez.

**Fault points** (`FaultInjector`, no-op em produção): pontos nomeados nos fluxos críticos, usados
pelos testes para simular crash, erro ou atraso. Não há `if (test)` no código de produção.

### 7.4 Consultas e reconciliação (T11)

- **Ledger:** o cursor é base64url de `{"v": wallet_version}` (opaco, A20). Como `wallet_version` é
  único e crescente por wallet, as páginas não pulam nem repetem entradas mesmo com inserts concorrentes
  (há teste). `limit` vai de 1 a 200, com default 50.
- **Reconciliação (A19):** roda numa transação `REPEATABLE READ READ ONLY`, um snapshot consistente que
  não bloqueia a wallet. Confere três coisas: `Σ CREDIT − Σ DEBIT == balance`, `balance_after` da última
  entrada `== balance` e versão da última entrada `== version`. Divergências vão para um
  `ReconciliationObserver` (log + métrica na T23) e **nunca são corrigidas**.

## 8. API HTTP e mapeamento de status

### 8.1 Estrutura (T12)

- O Nest só existe em `src/infrastructure/http`. Os controllers são adaptadores finos: validam o
  contrato com **zod estrito** (campo desconhecido → 400), chamam o use case do container e apresentam o resultado.
- **Composition root** (`infrastructure/app/container.ts`): monta ORM, `TransactionRunner`, use cases,
  porta de identidade e checks de readiness. O `AppModule.register(container)` recebe tudo pronto, sem
  injeção mágica de repositórios.
- **Body parser próprio** (`express.json`, limite de 64 kB). Assim JSON malformado também sai no formato
  padrão de erro (`MALFORMED_JSON`).
- **Correlation id:** `X-Correlation-Id` é aceito quando bem formado (ou gerado) e devolvido na resposta.
  Vira `correlationId` dos eventos. Na submissão, a `Idempotency-Key` é o `causationId`.

### 8.2 Mapa de status (consistente em todos os endpoints)

| Status | Quando | `error.code` (quando erro) | O provedor deve… |
|---|---|---|---|
| 201 | transação nova PROCESSED / wallet criada | — | — |
| 200 | replay de PROCESSED (`idempotentReplay: true`) / consultas | — | — |
| 202 | PENDING_REFERENCE (nova ou replay) | — | aguardar (consultar depois) |
| 400 | payload/header/query inválido | `VALIDATION_ERROR`, `INVALID_MONEY`, `INVALID_CURRENCY`, `MALFORMED_JSON` | corrigir |
| 401 / 403 | (só com IdP real) credencial ausente / provider não autorizado | `UNAUTHENTICATED`, `PROVIDER_FORBIDDEN` | autenticar |
| 404 | wallet/transação/rota inexistente | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND` | corrigir |
| 409 | conflito de idempotência / wallet duplicada | `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS` | não reenviar igual |
| 422 | rejeição de regra de negócio (nova ou replay) | o próprio `failureCode` (+ `providerAction`) | ver §4.2 |
| 500 | erro interno permanente; transação FAILED (nova ou replay) | `INTERNAL_ERROR` | contatar o operador |
| 503 | falha transitória (lock_timeout, banco/fila indisponível) + `Retry-After` | `TRANSIENT_INFRASTRUCTURE_ERROR` (+ `reason`) | reenviar com a mesma key |

**Replay mantém o status original (A11):** 200 (PROCESSED), 202, 422 ou 500, sempre com o mesmo
corpo e `idempotentReplay: true`. Um replay de rejeição nunca parece sucesso.

**Formato único de erro:** `{ "error": { "code", "message", ...detalhes } }`. Na 422 os detalhes são
`providerAction`, `transactionId`, `status`, `balance` (saldo observado) e `idempotentReplay`.

### 8.3 Contratos

- `POST /wallets` → `{ id, playerId, balance, version }`.
- `GET /wallets/:walletId/ledger?cursor&limit` → `{ walletId, items: [{ id, transactionId, direction,
  money, balanceBefore, balanceAfter, walletVersion, createdAt }], nextCursor }` (`nextCursor: null` na última página).
- `POST /wagering/transactions` → `{ transactionId, status, balance, idempotentReplay }`, com `balance: null` em PENDING_REFERENCE.
- `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
  → visão completa da transação (inclui `failureCode`, referências, `balance` observado, datas).
- `POST /wallets/:walletId/reconciliation` → formato da §9 + `details`.
- Identificadores (A22): `walletId` é UUID; os demais têm de 1 a 128 caracteres ASCII imprimíveis sem
  espaço. A `Idempotency-Key` tem de 1 a 255 caracteres.

## 9. Mensageria: inbox, outbox, PENDING_REFERENCE

_(dia 2)_

## 10. Autenticação

**Decisão:** não implementar. Autenticação não vale pontos (§2, §14) e não deve competir com
correção financeira. O ponto de extensão, porém, está **ligado e testado**:

- `ProviderIdentityPort.resolve(credentials) → ProviderIdentity { subject, providerIds }` (porta de aplicação).
- `AuthGuard` global (Nest) resolve a identidade e a anexa à requisição. `@Public()` libera
  `/health/*` (e `/metrics` no dia 3).
- Os controllers chamam `assertCanActAs(identity, providerId)`, de modo que o `providerId` do body (e o do path
  na consulta por id externo) precisa ser um dos que o chamador representa.
- O adapter atual é `NoopProviderIdentity` (todo chamador pode agir como qualquer provider). Um teste
  com um adapter restritivo prova a fiação: health continua aberto, chamada sem credencial → 401,
  provider não autorizado → 403.

**Desenho com Keycloak:**

1. Um *realm* `wagering` com um *client* confidencial por provedor (`provider-a`, …), usando o fluxo
   **OAuth2 client-credentials**. O provedor obtém o access token em
   `/realms/wagering/protocol/openid-connect/token` com `client_id`/`client_secret` (ou `private_key_jwt`).
2. Um *protocol mapper* coloca no token a claim `provider_id` (ou `azp` = client id), e a audiência
   `wagering-api` restringe o uso do token.
3. O adapter `OidcProviderIdentity` valida a assinatura via JWKS (`/protocol/openid-connect/certs`,
   com cache e rotação), `iss`, `aud`, `exp`/`nbf`, e devolve `{ subject: sub, providerIds: [provider_id] }`.
4. Token inválido ou ausente → 401. `providerId` do body diferente do token → 403. O token não entra no
   `payloadHash` (é transporte).
5. Na SQS, a fila é canal interno confiável (§2). A identidade do provedor na mensagem continua sujeita
   às validações de domínio (provider reservado, referência do mesmo provider etc.).
6. No Docker Compose: um serviço `keycloak` com o realm importado por arquivo JSON. Testes de
   integração obteriam tokens reais via client-credentials.

## 11. Observabilidade

_(dia 3)_

## 12. Trade-offs e limitações

_(contínuo)_

## Apêndice A — Interpretações da especificação (A1–A32)

Pontos em que o enunciado do desafio é ambíguo, com a interpretação adotada. As referências
`Ax` espalhadas pelo código e por este documento apontam para cá; `§n` são seções do enunciado.

### Regras de negócio

| Id | Tema | Interpretação adotada |
|---|---|---|
| A1 | Formato de `amount` | Estrito `^(0\|[1-9]\d{0,17})\.\d{2}$`: rejeita `"25"`, `"25.5"`, zeros à esquerda e sinal. O hash não depende de normalização. |
| A2 | Valor zero | BET/WIN/REFUND/ROLLBACK exigem > 0; LOSS aceita ≥ 0 (sem efeito no saldo); `initialBalance` ≥ 0, e 0 não gera OPENING nem lançamento. Fora disso, 400. |
| A3 | Moedas | `^[A-Z]{3}$` com allowlist configurável (`SUPPORTED_CURRENCIES`, default `BRL,USD,EUR`), escala sempre 2. JPY/KWD fora de escopo. |
| A4 | Reversão única | Uma BET é revertida no máximo uma vez, por REFUND **ou** ROLLBACK (índice parcial). `BET → REFUND → ROLLBACK(REFUND)` é permitido. ROLLBACK de LOSS, ROLLBACK ou OPENING → `REFERENCE_KIND_NOT_ALLOWED`. |
| A5 | WIN/LOSS com referência | Referência opcional; se vier, valida provider, player, wallet, moeda, rodada e tipo BET. Ausente no banco → PENDING_REFERENCE. Vários WIN por BET são permitidos e o valor é livre. |
| A6 | Liquidação × reversão | WIN de BET já revertida → `REFERENCE_ALREADY_REVERSED`. REFUND/ROLLBACK de BET que já tem WIN é **permitido** (risco documentado em §4.5: o provedor deve reverter o WIN antes). |
| A7 | Referência não terminal ou falha | Referência em PENDING_REFERENCE → o dependente também espera. Referência REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`. |
| A8 | Payload estruturalmente inválido | 400 sem persistir: BET com referência, autorreferência, kind OPENING, providerId reservado `internal`. |
| A9 | Wallet inexistente | HTTP 404 `WALLET_NOT_FOUND` sem consumir a key. Na SQS: erro de negócio terminal (inbox + ack + métrica). |
| A10 | O que vira REJECTED | Toda rejeição de regra após a wallet ser encontrada. Consome a key, grava o saldo observado e não gera lançamento. |
| A11 | Status do replay | Status original: 200 PROCESSED, 422 REJECTED, 202 PENDING_REFERENCE, mesmo corpo e `idempotentReplay: true`. |
| A12 | Replay após mudança de estado | Devolve o estado persistido atual; depois de terminal, é imutável (trigger). |
| A13 | Unicidade do external id | `(providerId, externalTransactionId)` existente com outra key → 409 `EXTERNAL_TRANSACTION_CONFLICT`. A idempotency key é global, até 255 caracteres. |
| A14 | Campos do hash | providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, amount, currency, referenceExternalTransactionId (omitido se ausente). Mesmo hash em HTTP e SQS. Detalhe em §7.1. |
| A15 | Estado PENDING | Estado inicial em memória; nenhum fluxo commita PENDING. |
| A16 | FAILED | Só para erro permanente não-negócio após o payload ser aceito (gravado numa tx separada, HTTP 500, SQS → DLQ). Erro transitório esgotado não vira FAILED. |
| A17 | OPENING | `providerId = internal`, `externalTransactionId = opening:{walletId}`, key `internal:opening:{walletId}`, round/game NULL. Emite eventos; saldo inicial 0 não emite. |

### Contrato da API

| Id | Tema | Interpretação adotada |
|---|---|---|
| A18 | `POST /wallets` | Sem Idempotency-Key; deduplicação por `UNIQUE(player_id, currency)` → 409. |
| A19 | Reconciliação | Snapshot `REPEATABLE READ` read-only; compara Σ ledger com o saldo e com o último `balance_after`. 200 com `consistent: false` em divergência; 404 sem wallet. |
| A20 | Cursor do ledger | Ordem por `wallet_version`; cursor opaco (base64url de `{"v":n}`); `limit` 50 por padrão, máximo 200. |
| A21 | Corpos não-201 | 202 e replays no formato de sucesso (`balance: null` se pendente); 422 no formato de erro com `failureCode` em `code`. |
| A22 | Identificadores | `walletId` UUID; os demais ids são ASCII imprimível sem espaço, 1–128 caracteres. |
| A23 | Provedores | Sem registro de provedores; `internal` é reservado. Autorização via `ProviderIdentityPort` (no-op). |

### Mensageria e operação

| Id | Tema | Interpretação adotada |
|---|---|---|
| A24 | Fila de eventos | `wagering-events.fifo`, `MessageGroupId = walletId`, `MessageDeduplicationId = eventId`. Consumidores usam `walletVersion` e `eventId`, não a ordem. |
| A25 | Consumidor de eventos | Consumidor de auditoria (teste) com inbox (`consumerName = events-audit`, `messageId = eventId`). |
| A26 | `MessageGroupId` de entrada | Produtor deveria usar `walletId`, mas a correção não depende disso (testes usam groups aleatórios). |
| A27 | Erros no consumidor | Negócio → ack. Transitório → `ChangeMessageVisibility` com backoff. Permanente → DLQ imediata. Limite de recebimentos na aplicação + redrive como rede de segurança. Detalhe em §9. |
| A28 | Limites de PENDING_REFERENCE | 10 tentativas, base 2s, fator 2, cap 5 min (configurável), mais wake-up imediato dos dependentes quando a referência é processada. |
| A29 | Outbox | Sem limite de tentativas; backoff 1s→60s com jitter. Retenção/limpeza fora de escopo. |
| A30 | Métrica de conflito de lock | Histograma de espera de lock + contadores de `lock_timeout`, deadlock e version mismatch. |
| A31 | Instância | Um processo `bun run start`; `ROLES` separa API, consumidor, publisher e worker. |
| A32 | Timeouts | `lock_timeout` 5s, `statement_timeout` 10s; deadlock/serialização com até 3 retries e jitter; depois, 503. |
