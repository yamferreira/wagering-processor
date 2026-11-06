# ARCHITECTURE.md — Distributed Wagering Processor

> Decisões, garantias, trade-offs e limitações da solução. Cada seção indica a seção do enunciado
> (`§n`) que atende. As interpretações da especificação (`A1…A32`)
> estão no [Apêndice A](#apêndice-a--interpretações-da-especificação-a1a32). Setup e comandos: `README.md`.

## 1. Visão geral

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas por
HTTP e por SQS, com saldo materializado por wallet, ledger append-only, idempotência persistente,
Transactional Outbox e Inbox, correto com várias instâncias concorrentes.

```
 provedor ──HTTP──▶ [api] ─┐                                       ┌─▶ [publisher] ──▶ wagering-events.fifo
                           ├─▶ SubmitWagerTransaction ─▶ PostgreSQL ┤      (FOR UPDATE SKIP LOCKED, backoff)
 provedor ──SQS───▶ [consumer] (inbox na mesma tx) ┘   │  1 transação: │
   wager-transactions.fifo  ──(falha permanente)──▶ DLQ │  wallet FOR UPDATE + wager + ledger
                                                        │  + saldo + outbox (+ inbox)
                       [pending-worker] ◀───────────────┘  PENDING_REFERENCE (SKIP LOCKED + lease,
                                                            backoff, wake-up quando a referência chega)
```

O PostgreSQL é a fonte de verdade de tudo que precisa ser correto: unicidade, imutabilidade, saldo ≥ 0,
saldo ⇔ ledger, reversão única e serialização por wallet. SQS FIFO, a ordem de chegada e a memória dos
processos nunca são usadas como garantia.

### 1.1 Onde está cada justificativa pedida pelo enunciado

| O enunciado pede | Onde |
|---|---|
| Escolha do ORM, mapeamento do Money e estratégia transacional (§4) | §2, §4.1, §5.4, §6.1 |
| Estratégia de concorrência justificada; `version` × alternativa (§6.2, §8) | §6.1, §6.2, §9.5 |
| Transições válidas da máquina de estados (§6.3) | §4.4 |
| Interpretações adicionais das regras (§7) | §4.5 e Apêndice A |
| Limite de tentativas / TTL de PENDING_REFERENCE justificado (§7.1) | §4.5 (política), §9.4, A28 |
| Taxonomia de `failureCode` com a ação do provedor (§7.2) | §4.2 |
| Algoritmo do `payloadHash` (§9) | §7.1 |
| Mapa de status HTTP consistente (§9) | §8.2 |
| Reconciliação e divergências (§9) | §7.4 |
| Health checks (§9) | §8.4 |
| SQS: inbox, ack após commit, classificação de erros, DLQ, SIGTERM (§10) | §9.1, §9.2 |
| Transactional Outbox com publishers concorrentes (§11) | §9.3, §9.5 |
| Observabilidade (§12) | §11 |
| Garantias no schema (§5) | §5.2 |
| Autenticação não implementada + desenho (§2) | §10 |
| Trade-offs e limitações (§14) | §12 |
| Teste de carga (§14, diferencial) | `docs/LOAD-TEST.md` |

## 2. Stack e versões

| Item | Escolha | Observação |
|---|---|---|
| Runtime / PM / testes | Bun **1.3.14** (fixado em `packageManager`/`engines` e no CI) | `bun test` como runner |
| Linguagem | TypeScript 7.0.2 (strict) | só para typecheck (`tsc --noEmit`); o Bun transpila em runtime |
| Framework | NestJS 12.3.3 (platform-express) | só em `src/infrastructure/http` |
| ORM | MikroORM 7.2.7 (driver PostgreSQL) | `EntitySchema`, sem decorators no domínio |
| Banco | PostgreSQL **16.15** (`postgres:16.15-alpine`) | `max_connections=300` |
| Mensageria | AWS SQS via LocalStack **4.14.0** | ver 2.1 |
| Validação de contrato | zod 4 | schemas estritos nos DTOs HTTP e no envelope SQS |
| Logs / métricas | pino / prom-client | |

### 2.1 Decisões de ambiente

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

### 4.1 Money

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

### 4.2 Taxonomia de `failureCode` (§7.2)

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
| `BALANCE_LIMIT_EXCEEDED` | crédito (WIN, REFUND, ROLLBACK de BET) levaria o saldo além de `999999999999999999.99`, o máximo de `NUMERIC(20,2)` | `CONTACT_OPERATOR` |
| `INTERNAL_INVARIANT_VIOLATION` | erro permanente interno após o aceite (status FAILED, A16) | `CONTACT_OPERATOR` |

O saldo insuficiente numa BET e numa reversão têm códigos e ações diferentes. A primeira é rotina;
a segunda indica um estado contábil que precisa de intervenção (§7).

> Não existe ação `RETRY`: nenhum `failureCode` é retentável com a mesma key. O retry fica restrito
> a 503 e a falhas transitórias.

`WALLET_NOT_FOUND` (A9) não é `failureCode`: a transação não é persistida (FK) e a resposta é 404.

### 4.3 Wallet e WalletLedgerEntry

- **Única via de mudança de saldo:** `debit`/`credit` (e `move(direction)`, usado pelas regras).
  Cada chamada devolve o `WalletLedgerEntry` criado no mesmo passo. A entrada é construída e
  validada **antes** de o agregado mudar, então uma entrada inválida não deixa o saldo alterado.
- **`version`:** começa em 1. O crédito de abertura **não** incrementa a versão: a entrada de
  abertura leva `walletVersion = 1`, como no exemplo da §9, que mostra `version: 1` com saldo 1000.00.
  Cada movimento posterior incrementa a versão em exatamente 1, e a entrada registra a versão
  resultante. Daí vale a relação `version == nº de lançamentos` (ou `+1` se a wallet abriu com
  saldo zero), que o schema reforça com `UNIQUE(wallet_id, wallet_version)` (§5.1).
- **`walletVersion` no lançamento:** campo adicional ao esqueleto da §6.4. Serve de chave de
  ordenação estável do ledger (cursor, A20) e de elo de encadeamento (`balance_before` da versão
  *n* = `balance_after` da versão *n−1*).
- **Guardas:** `debit` lança `InsufficientFundsError` sem alterar estado. O caminho de negócio
  verifica `canDebit` antes (§4.5) e transforma isso em `INSUFFICIENT_FUNDS` /
  `REVERSAL_INSUFFICIENT_FUNDS`. Movimento zero ou de outra moeda é rejeitado.
- **Abertura:** `Wallet.open` recebe os ids da transação OPENING e do lançamento (o domínio não
  gera ids). Com saldo inicial zero não há OPENING nem lançamento.
- **Imutabilidade do lançamento:** campos `readonly` + `Object.freeze`, e datas copiadas
  defensivamente. `create` valida a aritmética, valores positivos, uma única moeda, saldos não negativos e `walletVersion ≥ 1`.

### 4.4 WagerTransaction: máquina de estados

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

### 4.5 Regras de negócio: `decide()` + `applyDecision()` (§7)

`decide(tx, wallet, lookup)` é uma função pura. O use case a chama **com o lock da wallet
adquirido**, então `wallet` e `lookup` refletem o último estado commitado e não mudam durante
a decisão. A saída é uma das variantes `APPLY(direction)`, `RECORD_ONLY` (LOSS), `REJECT(code)` ou
`PENDING_REFERENCE`. `applyDecision` é o único ponto em que uma transação de aposta move o
saldo: saldo, lançamento e status mudam juntos.

Ordem de avaliação (a primeira regra que falha decide):

1. `playerId` ≠ dono da wallet → `WALLET_PLAYER_MISMATCH`; moeda ≠ moeda da wallet → `CURRENCY_MISMATCH`.
2. Se há referência:
   - não encontrada → `PENDING_REFERENCE` (`waitingFor: REFERENCE_MISSING`, cada retry gasta tentativa);
   - tipo não permitido → `REFERENCE_KIND_NOT_ALLOWED`. Permitidos: WIN/LOSS/REFUND → BET; ROLLBACK → BET, WIN, REFUND;
   - provider, player, wallet, moeda ou rodada divergentes → `REFERENCE_MISMATCH` + `details.field`;
   - referência ainda em PENDING/PENDING_REFERENCE → `PENDING_REFERENCE` (`waitingFor: REFERENCE_IN_FLIGHT`, não gasta tentativa, A7); REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`;
   - reversão com valor diferente → `REFERENCE_AMOUNT_MISMATCH`;
   - referência já revertida → `REFERENCE_ALREADY_REVERSED`. Vale para reversões (A4) e para WIN/LOSS sobre BET revertida (A6).
3. LOSS → `RECORD_ONLY`, sem lançamento e sem incrementar a versão.
4. Direção DEBIT sem saldo: BET → `INSUFFICIENT_FUNDS`; ROLLBACK → `REVERSAL_INSUFFICIENT_FUNDS`.
   Direção CREDIT que passaria do máximo representável → `BALANCE_LIMIT_EXCEEDED` (422, REJECTED). O limite
   é previsível e de negócio: não é um erro interno (FAILED/500) e não chega ao `MoneyOverflowError`.
5. Caso contrário → `APPLY`.

**Risco documentado (A6):** REFUND ou ROLLBACK de uma BET que já tem WIN é **permitido**, conforme
a spec literal. O provedor deve fazer o ROLLBACK do WIN antes. Bloquear isso exigiria uma regra
não prevista na especificação, que só pegaria WINs com referência.

**PENDING_REFERENCE com backoff (§7.1, A28):** `ReferenceRetryPolicy`, de domínio e pura:
`delay(n) = min(base · 2ⁿ, cap)`. O default é 10 retries, base 2s e cap 5 min, o que dá
2+4+8+…+256+300+300 = 1110 s (≈ 18,5 min) até `REJECTED / REFERENCE_NOT_FOUND`. A primeira
marcação agenda sem contar tentativa; o retry nº `maxAttempts` que ainda não encontra a
referência rejeita. Os parâmetros são configuráveis por env (§9.4).

**Referência que existe mas ainda está pendente (A7):** o dependente **não** gasta tentativas
enquanto a referência está em PENDING_REFERENCE; ele espera a referência ficar terminal. Isso
termina sempre, porque a própria referência tem orçamento finito: quando ela fica terminal, o
wake-up (A28) acorda o dependente, que é aplicado (referência PROCESSED) ou rejeitado com
`REFERENCE_NOT_PROCESSED` (referência REJECTED ou FAILED). Um re-check a cada `cap` fica como rede
de segurança. Assim, `REFERENCE_NOT_FOUND` só aparece quando a referência de fato nunca chegou.
Sem essa regra, `ROLLBACK(WIN) → WIN(BET) → BET` podia esgotar o ROLLBACK enquanto o WIN esperava a
BET: o ROLLBACK era rejeitado como "referência inexistente", o WIN era creditado depois e o saldo
terminava 30.00 acima do esperado pelo provedor (teste de integração dedicado).

**Justificativa do limite:** entregas fora de ordem entre provedores costumam se resolver em
segundos ou minutos. Esperar 18 min cobre filas atrasadas e retries do provedor sem manter
transações pendentes indefinidamente. Além disso, o wake-up (A28) resolve na hora quando a
referência chega.

### 4.6 Eventos de integração, Outbox e Inbox (§6.5, §11)

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

### 5.1 Migrations

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
| Lost update | `UNIQUE (wallet_id, wallet_version)`, além do lock e do `WHERE version = ?` (§6.1) |
| Transação terminal imutável | trigger `wager_tx_guard_update`: nada muda após PROCESSED/REJECTED/FAILED, colunas de negócio nunca mudam e não há volta para PENDING. DELETE/TRUNCATE proibidos |
| Coerência de status | CHECKs: `failure_code` ⇔ REJECTED/FAILED; PROCESSED exige `processed_at` + `resulting_balance`; PENDING_REFERENCE exige `next_reference_attempt_at` |
| Regras por kind | REFUND/ROLLBACK exigem referência; BET/OPENING não podem ter; valor > 0 exceto LOSS; `provider_id = 'internal'` ⇔ OPENING; round/game obrigatórios exceto OPENING |
| Outbox/Inbox | PK da outbox = `eventId`; conteúdo imutável e publicação definitiva (trigger). Inbox com PK `(consumer_name, message_id)` e imutável |
| Lançamento descreve a sua transação | trigger `ledger_check_transaction` (AFTER INSERT, imediato): a transação precisa estar PROCESSED e não ser LOSS, com o mesmo valor e moeda; a direção segue o kind (BET → DEBIT; WIN/REFUND/OPENING → CREDIT; ROLLBACK → o inverso do que reverte) → `23000`. Migration `Migration20261106000000_ledger_matches_transaction` |
| Ninguém em runtime burla o schema | role `wagering_app` (migration `…_runtime_role`): `NOSUPERUSER`, não é dono de nada, `SELECT, INSERT, UPDATE` nas tabelas de estado e só `SELECT, INSERT` no ledger. `UPDATE/DELETE/TRUNCATE` no ledger, `DISABLE TRIGGER`, `session_replication_role = replica` e DDL → `42501` (testado) |

`resulting_balance_currency` existe porque o saldo observado é na moeda da **wallet**, que numa
rejeição `CURRENCY_MISMATCH` difere da moeda da operação.

**Custo dos triggers deferred:** dois lookups indexados por `(wallet_id, wallet_version)` por
commit que toca a wallet. É aceito em troca da garantia, no próprio banco, de que saldo e
ledger não divergem mesmo diante de um bug na aplicação ou de SQL manual.

**Dois roles:** o serviço conecta como `wagering_app` (`DATABASE_URL`) e as migrations como o dono do
schema (`MIGRATION_DATABASE_URL`). Se o runtime usasse o superusuário das migrations, poderia, em tese,
desligar os triggers. Assim, só o dono ou um superusuário consegue (intervenção manual), e a
reconciliação detecta a divergência (§7.4). Em
desenvolvimento a migration cria o role com uma senha fixa; em produção o role e o segredo vêm de fora, e a
migration só concede os privilégios.

### 5.3 Infraestrutura de teste

Há um database template migrado por processo de teste (`wagering_test_tpl_<pid>`), clonado com
`CREATE DATABASE … TEMPLATE` para cada arquivo de teste. Templates de processos mortos são
removidos na inicialização seguinte. `assertLedgerInvariant` compara tudo em SQL (`NUMERIC`), nunca
em `number`, e tem um teste negativo que prova que detecta divergências.

- **Timeout de teste:** o Bun 1.3.14 ignora `[test] timeout` do bunfig e aplica `setDefaultTimeout` de um
  preload só ao primeiro arquivo (verificado). Por isso cada arquivo de integração/concorrência chama
  `setDefaultTimeout` no topo, e os scripts do package.json passam `--timeout`.
- **Mensageria em teste:** `createMessagingHarness` cria um banco novo, filas reais no LocalStack com
  prefixo único e runtimes in-process com os papéis pedidos; `spawnInstance` sobe processos reais de
  `src/main.ts` (prontidão via IPC, nenhum órfão: todos são mortos no teardown e no exit do runner).
- **Harness de processos:** `spawnCluster(h, n)` sobe N instâncias reais (`bun src/main.ts`, todos os
  papéis por padrão, porta 0 informada pelo filho via IPC) sobre o mesmo banco e as mesmas filas.
  `stop()` é gracioso (SIGTERM em POSIX, IPC no Windows) e `kill()` é crash (SIGKILL/TerminateProcess).
  Todo filho é registrado e morto no `afterEach`/`afterAll` e no `exit` do runner; o teste do harness
  confere por PID que nenhum processo sobrevive. `fireHttp` dispara todas as requisições de uma vez
  (round-robin entre instâncias), `fireSqs` envia em lotes de 10 em paralelo (com `MessageGroupId`
  aleatório quando se quer anular a ordenação do broker) e `waitForQuiescence` espera fila vazia, outbox
  100% publicada e nenhuma PENDING_REFERENCE vencida, estável por 3 leituras seguidas.
- **Separação das suítes:** `bun test` roda unidade + integração (o `bunfig.toml` ignora `test/concurrency/**`
  com `pathIgnorePatterns`); `bun run test:concurrency` roda a concorrência explicitamente
  (`--path-ignore-patterns=__none__`) e `bun run test:all` roda as duas. Juntas, passariam de 3 minutos.

### 5.4 Mapeamento MikroORM

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

### 6.1 Estratégia (§8)

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

**Estratégia transacional:** uma transação SQL curta por operação, em **READ COMMITTED**, com o lock
explícito da linha da wallet. Não usamos SERIALIZABLE: ele também evitaria lost updates, mas abortando
transações (40001) sob contenção, o que dá a mesma tempestade de retries do otimista numa hot wallet. Com
o `FOR UPDATE`, cada leitura relevante (saldo, idempotência, referência e reversão) é feita **depois** de
obter o lock, então em READ COMMITTED ela já vê o último commit da wallet. A reconciliação é a única
leitura multi-statement que precisa de snapshot e usa `REPEATABLE READ READ ONLY` (sem lock).

**Sem lock global:** o lock é só da linha da wallet. Wallets diferentes rodam em paralelo,
provado por teste determinístico: com a wallet X travada, a Y faz commit e a X expira por `lock_timeout`.

**Limites:** `lock_timeout = 5s` (`DB_LOCK_TIMEOUT_MS`) evita filas infinitas atrás de uma
transação travada; ao estourar, a requisição recebe 503 e pode ser reenviada com a mesma key.
Transações curtas (sem I/O externo dentro do lock, já que a publicação é via outbox) mantêm o tempo de lock em milissegundos.

**Ordem global de locks:** wallet primeiro, depois linhas de `wager_transactions`. Nenhum fluxo
trava duas wallets (a referência pertence à mesma wallet, garantido por FK composta), então não
existe deadlock entre wallets. O wake-up de dependentes (§9.4) pode atualizar a linha de uma transação
pendente de **outra** wallet (o dependente guarda só o external id da referência enquanto espera), mas
só trava essa linha de `wager_transactions`, nunca uma segunda wallet. O worker que segura essa linha já
tem o lock da wallet dela e não espera pela primeira, então não se forma ciclo. O claim do worker usa
`SKIP LOCKED` e nunca espera.

### 6.2 Suíte de concorrência in-process (§8, §13)

Paralelismo real no PostgreSQL (pools de 20 a 40 conexões, todas as operações disparadas de uma vez com
`Promise.all`, sem mocks):

| Teste | Resultado verificado |
|---|---|
| A mesma BET 50× por HTTP (+5 repetições) | 1 débito, exatamente um 201 e 49 respostas 200 com replay, o mesmo `transactionId` e o mesmo saldo |
| A mesma BET 50× por SQS: 50 `messageId`s e 50 `MessageGroupId`s distintos, 2 consumidores | 1 débito, 1 transação |
| O mesmo `messageId` 50× por grupos distintos | 1 débito, 1 linha de inbox |
| §8 repetido 20×: saldo 100.00 e duas BETs de 80.00 | sempre 201 + 422 `INSUFFICIENT_FUNDS` (saldo observado 20.00), saldo final 20.00, 1 DEBIT; o retry das duas dá 200 + 422 com replay e nada muda |
| Hot wallet: 220 operações mistas (BET/WIN/LOSS/REFUND/ROLLBACK e reversões disputadas) | saldo ≥ 0, sem PENDING_REFERENCE/FAILED no fim, 1 lançamento por transação que move saldo, no máximo 1 reversão por BET, saldo = recomputado a partir das transações = ledger |
| 50 wallets × 20 operações (1000 de uma vez, intercaladas) | cada wallet exata (35.00, 21 lançamentos, version 21) |
| Lock por linha (determinístico) | com X travada, Y faz commit em < 0,9s e X recebe `LOCK_TIMEOUT` |

**Throughput por processo:** uma submissão faz cerca de 12 round-trips e o processo fica limitado por CPU
(CPU ≈ wall) enquanto o PostgreSQL fica ocioso. O teste de carga mediu a causa (`docs/LOAD-TEST.md`): pelo driver
`pg` do MikroORM no Bun, cada round-trip consome tanta CPU quanto dura (espera ativa). O custo é por
*espera*, não por instrução: cerca de 8 ms de CPU por requisição no Linux e 16 ms no Windows sob carga,
32 ms em sequência e ~10 ms com 40 em paralelo. O custo não vem do trabalho do ORM (fork, queries,
hidratação) nem de contenção de lock.

## 7. Idempotência

### 7.1 Algoritmo do `payloadHash` (§9, A14)

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
§5.1). Essa função só interpreta a colisão.

### 7.3 Fluxo de `SubmitWagerTransaction`

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

### 7.4 Consultas e reconciliação

- **Ledger:** o cursor é base64url de `{"v": wallet_version}` (opaco, A20). Como `wallet_version` é
  único e crescente por wallet, as páginas não pulam nem repetem entradas mesmo com inserts concorrentes
  (há teste). `limit` vai de 1 a 200, com default 50.
- **Reconciliação (A19):** roda numa transação `REPEATABLE READ READ ONLY`, um snapshot consistente que
  não bloqueia a wallet. Confere três coisas: `Σ CREDIT − Σ DEBIT == balance`, `balance_after` da última
  entrada `== balance` e versão da última entrada `== version`. Divergências **nunca são corrigidas**.
- **Divergência (§9):** a resposta continua 200, com `consistent: false`, `difference` com sinal
  (`stored − calculated`) e `details`. O `ReconciliationObserver` do container emite um log de **error**
  (`reconciliation divergence…`, com `walletId`, `checkedEntries`, `ledgerSumMatches` e os booleanos de
  `details`, sem valores) e incrementa `reconciliation_divergences_total`. Como o schema impede que a
  aplicação crie uma divergência, o teste a provoca como superusuário, com o trigger
  `wallet_check_ledger` desabilitado. A divergência é reportada a cada nova reconciliação até alguém
  intervir (o saldo armazenado não muda).

## 8. API HTTP e mapeamento de status

### 8.1 Estrutura

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
`failureCode` (igual a `code`, o mesmo nome de campo do GET, da 500 e do evento `WagerTransactionRejected`),
`providerAction`, `transactionId`, `status`, `balance` (saldo observado) e `idempotentReplay`. Na 500 de uma
transação gravada como FAILED: `transactionId`, `status: FAILED`, `failureCode` e `idempotentReplay`. A
primeira resposta e o replay montam o corpo pela mesma função, então só `idempotentReplay` muda.

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

### 8.4 Health e falhas transitórias (§3, §9)

- `GET /health/live`: sempre 200 enquanto o processo responde, sem checar dependências (uma queda do
  banco não deve fazer o orquestrador reiniciar processos saudáveis).
- `GET /health/ready`: checa `postgres` (`SELECT 1`) e `sqs` (`GetQueueAttributes` da fila de entrada), cada
  um com timeout de 2s, e reporta cada dependência separadamente:
  `{ "status": "not_ready", "checks": { "postgres": { "status": "up" }, "sqs": { "status": "down", "error": "…" } } }`
  com 503 quando qualquer uma cai.
- **Boot sem dependências:** o processo sobe com o PostgreSQL ou a SQS fora do ar (o pool conecta sob
  demanda e as URLs das filas são resolvidas no primeiro uso). Ele fica `not_ready` e se recupera sozinho
  quando a dependência volta.
- **503 + `Retry-After: 1`** para toda `TransientInfrastructureError`, em todos os endpoints: conexão recusada
  ou caída, `lock_timeout` (55P03), `statement_timeout` (57014) e deadlock/serialização depois dos retries
  internos. O `reason` diz qual foi. Nada fica meio gravado (a transação SQL inteira faz rollback), então o
  provedor reenvia com a mesma key. Validação de payload continua respondendo 400 sem tocar no banco.
- **SQS fora do ar não afeta a HTTP:** a submissão grava o evento na outbox, e o publisher só o envia
  quando a fila voltar (§9.3).

## 9. Mensageria: inbox, outbox, PENDING_REFERENCE

### 9.1 Topologia de filas (§10, A24)

| Fila | Papel | Atributos |
|---|---|---|
| `wager-transactions.fifo` | entrada `WagerTransactionRequested` | FIFO, `ContentBasedDeduplication=false`, visibility 30s, `RedrivePolicy` → DLQ com `maxReceiveCount=6` |
| `wager-transactions-dlq.fifo` | mensagens permanentes ou esgotadas | FIFO, retenção 14 dias |
| `wagering-events.fifo` | destino da outbox (A24) | FIFO, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId` |

- **Provisionamento** (`scripts/setup-queues.ts` → `provisionQueues`): cria a DLQ, lê o ARN e cria a
  entrada com o redrive. É idempotente: se a fila já existe, faz `SetQueueAttributes` para convergir
  (rodar duas vezes, ou com atributos alterados, não falha).
- **URLs:** o LocalStack devolve URLs virtual-host (`sqs.<região>.localhost.localstack.cloud`), que só
  resolvem por DNS público. `normalizeQueueUrl` mantém o path e usa o `SQS_ENDPOINT` configurado,
  então nada depende de DNS externo.
- **Deduplicação do broker** (`MessageDeduplicationId`, janela de 5 min) existe, mas **não** é usada
  como garantia: a correção vem da inbox e das constraints do banco (§5: "não confiar apenas em SQS FIFO").
- **Validação do LocalStack 4.14.0** (`test/integration/messaging/sqs.test.ts`): FIFO, deduplicação
  explícita, envio em lote, `ChangeMessageVisibility` (0 e N segundos, com `ApproximateReceiveCount`
  crescente) e redrive para a DLQ ao exceder `maxReceiveCount` funcionam. Não foi preciso trocar para
  o MiniStack.
- **Isolamento em teste:** cada arquivo de teste cria suas próprias filas com prefixo único
  (`t<pid>-<label>-<rand>-…`) e as apaga no `afterAll`.

### 9.2 Consumidor de `WagerTransactionRequested` (§10, A9, A27)

**Fluxo por mensagem** (`HandleWagerMessage` + `WagerTransactionConsumer`):

1. `parseWagerEnvelope`: JSON e schema estrito (o mesmo contrato do body HTTP + `idempotencyKey`;
   `correlationId` opcional). `payloadHash` da inbox = SHA-256 do envelope canônico.
2. Fast path: `inbox.find(consumerName, messageId)`. Já existe com o mesmo hash → duplicata, ack sem
   tocar em nada. Hash diferente → `MESSAGE_ID_CONFLICT` (DLQ).
3. **O mesmo use case da HTTP** (`SubmitWagerTransaction`) com um hook que insere a linha da inbox
   **dentro da mesma transação SQL** do wager, ledger, wallet e outbox (§11). O hook roda antes do lock
   da wallet: duas entregas concorrentes da mesma mensagem colidem na PK da inbox (a segunda espera o
   commit da primeira e recebe 23505 → duplicata), sem nem disputar a wallet.
4. O veredito de idempotência (replay × conflito) é avaliado **dentro** da transação: um conflito
   (`IDEMPOTENCY_KEY_REUSED`/`EXTERNAL_TRANSACTION_CONFLICT`) faz rollback também da linha da inbox, então
   um redrive da DLQ volta a falhar do mesmo jeito em vez de virar uma "duplicata" silenciosa.
5. Commit → fault point `consumer:after-commit-before-ack` → `DeleteMessage` (ack).

**Classificação de falhas** (`classifyConsumerError`):

| Situação | Ação | Detalhe |
|---|---|---|
| PROCESSED, REJECTED (regra de negócio), PENDING_REFERENCE, replay | ack | rejeição é resultado, não erro |
| Wallet inexistente (A9) | ack | grava só a inbox (tx separada) e conta como terminal |
| `TransientInfrastructureError` ou erro não classificado | retry | `ChangeMessageVisibility(min(base·2^receiveCount, cap))`; no `SQS_MAX_RECEIVES`-ésimo recebimento vai para a DLQ |
| Envelope inválido, `ValidationError`/money, conflito de idempotência, `MESSAGE_ID_CONFLICT`, FAILED (A16) | DLQ imediata | determinístico: repetir não ajuda |
| `InjectedFaultError` (teste) | abandon | sem ack e sem mudar a visibilidade: simula a morte do processo |

- **Ida para a DLQ** feita pela aplicação: `SendMessage` na DLQ (com atributos `failureAction`,
  `failureCode`, `failureReason`, `receiveCount`) e depois `DeleteMessage` na entrada. Um crash entre os
  dois deixa uma cópia na DLQ e uma reentrega, que a inbox deduplica. O `RedrivePolicy`
  (`maxReceiveCount=6` > `SQS_MAX_RECEIVES=5`) é só a rede de segurança para crash loops (ex.: o processo
  morre sempre na mesma mensagem e nunca chega a classificar).
- **Ordem:** mensagens do mesmo `MessageGroupId` num lote são processadas em sequência; grupos diferentes,
  em paralelo (`CONSUMER_CONCURRENCY`). A correção não depende disso (A26).
- **Shutdown gracioso:** para de fazer polling, dá `SHUTDOWN_GRACE_MS` para as mensagens em andamento e
  devolve as restantes com `ChangeMessageVisibility(0)`. **O long poll aberto não é abortado:** abortar só
  cancela o lado do cliente, e o broker entregaria a mensagem devolvida a esse poll "morto", deixando-a
  invisível por um visibility timeout inteiro. Por isso o poll termina sozinho em até `SQS_WAIT_TIME_S`, e
  o que ele trouxer é devolvido na hora. O `stop()` espera o **loop inteiro** do consumidor, não só o poll: assim essa devolução termina antes de o processo
  sair (teste com processo real: mensagem enviada durante o shutdown volta a ficar visível em segundos, não
  depois dos 30 s do visibility timeout). As esperas internas do loop (capacidade cheia, backoff de
  receive) são interrompidas pelo `stop()`. Uma mensagem
  devolvida cuja transação ainda termina durante o fechamento do pool não gera duplicata: a reentrega cai
  na inbox. O `main.ts` tem um deadline duro (`max(grace, wait) + 10s`) para nunca travar o término.
- **Sinais no Windows:** o Bun entrega `kill("SIGTERM")` a um processo filho como término imediato no
  Windows (verificado: exit 143 sem rodar o handler). O processo trata SIGTERM/SIGINT (Linux/containers) e
  também uma mensagem IPC `{ type: "shutdown" }`, que dispara o mesmo caminho. O harness de testes usa
  SIGTERM real em POSIX e IPC no Windows. O canal IPC só existe quando `src/main.ts` é iniciado direto
  (`bun src/main.ts`, como faz o harness): o wrapper `bun run start` não repassa mensagens IPC, mas trata
  Ctrl+C/SIGTERM normalmente, e matar o wrapper também encerra o filho (verificado, sem órfão).
- **Fault injection em processos filhos:** env `FAULTS="<ponto>=<ação>[*n]"` (`crash` = SIGKILL em si
  mesmo, `throw`, `transient`, `delay:<ms>`), lida pelo `EnvFaultInjector`. Vazia em produção (no-op).

### 9.3 Publisher da outbox (§11, A24, A29)

`PublishOutboxBatch` faz uma rodada numa única transação curta:

```
BEGIN
  SELECT … FROM outbox_messages
   WHERE published_at IS NULL AND next_attempt_at <= now
   ORDER BY next_attempt_at, id LIMIT OUTBOX_BATCH_SIZE
   FOR UPDATE SKIP LOCKED                       -- outbox_pending_due_idx
  SendMessageBatch (10 por chamada, em paralelo) → wagering-events.fifo
  UPDATE published_at = now()                    -- aceitos pelo broker
  UPDATE attempts+1, next_attempt_at = now()+backoff, last_error   -- recusados/erro
COMMIT
```

- **Por que segurar o lock durante o envio:** publishers concorrentes (quantas instâncias houver) nunca
  pegam as mesmas linhas, e o lock é só de linhas da outbox, nunca de wallets. O envio tem timeout curto
  (cliente SQS dedicado com 5s por request), e cada transação define `idle_in_transaction_session_timeout`
  (`DB_IDLE_IN_TX_TIMEOUT_MS`, 30s) como rede de segurança: um publisher travado não segura linhas para sempre.
- **Crash em qualquer ponto antes do COMMIT:** o lock some com a conexão e outro publisher assume as linhas.
  Se o broker já tinha aceitado o lote, o evento é publicado de novo (**at-least-once, nunca perdido**). É
  seguro porque o `eventId` é a chave de deduplicação: `MessageDeduplicationId = eventId` descarta
  republicações dentro da janela de 5 min do FIFO, e fora dela o consumidor deduplica por inbox. Os testes
  cobrem os dois pontos (`outbox:after-claim-before-publish` e `outbox:after-publish-before-mark`).
- **SQS indisponível:** a falha vira `scheduleRetry` dentro da mesma transação (`attempts` cresce,
  `next_attempt_at` segue 1s→60s com jitter de até −20%) e nada se perde. Sem limite de tentativas (A29).
- **Destino:** corpo = envelope `IntegrationEvent.toJSON()`; atributo de mensagem `eventType` em todo
  evento (testado), para o consumidor filtrar sem abrir o corpo;
  `MessageGroupId = aggregateId` (wallet para `WalletBalanceChanged`, transação para os eventos de
  transação). A ordem entre lotes/publishers não é garantida: consumidores usam `walletVersion` e `eventId`.
- **Loop:** `PollingWorker` repete imediatamente enquanto o lote vem cheio e espera `OUTBOX_POLL_MS` quando
  não; erros (ex.: banco fora) entram em backoff exponencial. `stop()` deixa a rodada atual terminar e
  nunca espera o intervalo ocioso nem o backoff (testado): o shutdown não atrasa até `*_POLL_MS`, nem 10 s
  com o banco fora do ar.
- **Consumidor de eventos de referência (A25):** `test/support/event-audit-consumer.ts` aplica cada evento
  a uma projeção na mesma transação que a sua linha de inbox (`events-audit`, `messageId = eventId`). Com
  cada evento entregue 3 vezes, a projeção conta cada um exatamente uma vez.

### 9.4 Worker de PENDING_REFERENCE (§7.1, A7, A28)

Cada rodada de `ResolvePendingReference` usa dois tipos de transação curta, nunca aninhados:

1. **Claim + lease:** `UPDATE … SET next_reference_attempt_at = now + PENDING_REF_LEASE_MS FROM (SELECT id …
   WHERE status = PENDING_REFERENCE AND next_reference_attempt_at <= now … FOR UPDATE SKIP LOCKED LIMIT n)`
   (`wager_tx_pending_reference_due_idx`). Só toca linhas de transação e nunca espera, então não entra em
   deadlock com submissões. O lease não conta como tentativa: se o worker morrer depois do claim, o item
   volta a ficar devido quando o lease expira (testado).
2. **Por item:** lock da **wallet** primeiro e depois da linha da transação (`FOR UPDATE`), a mesma ordem
   wallet → transação de todos os fluxos. Rechecagem do status (outro worker ou um wake-up pode ter
   resolvido o item: `SKIPPED`), `resolveReference` e o **mesmo** `decide()`/`applyDecision()` puro da
   submissão. O UPDATE usa `WHERE status = PENDING_REFERENCE` como guarda adicional.

- **Resultados:** PROCESSED (saldo + ledger + `WagerTransactionProcessed`/`WalletBalanceChanged`); REJECTED
  (regra de negócio, ou `REFERENCE_NOT_FOUND` ao esgotar `PENDING_REF_MAX_ATTEMPTS` com a referência
  ausente, com `WagerTransactionRejected`); ou reagendado, **sem** novo evento
  (`WagerTransactionPendingReference` saiu quando a transação ficou pendente): com `min(base·2ⁿ, cap)`
  gastando uma tentativa se a referência não existe, ou no `cap` sem gastar tentativa se ela existe
  e ainda está pendente (§4.5).
- **Wake-up (A28):** toda transação que fica terminal (PROCESSED, REJECTED ou FAILED), na submissão, no
  registro best-effort de FAILED ou no worker, executa na mesma
  transação SQL `UPDATE … SET next_reference_attempt_at = now WHERE status = PENDING_REFERENCE AND
  provider_id = ? AND reference_external_transaction_id = ?` (`wager_tx_pending_by_reference_idx`). O
  dependente é resolvido na próxima rodada do worker (`PENDING_REF_POLL_MS`), em vez de esperar o backoff.
  Isso vale em cascata: um ROLLBACK de um WIN que esperava a BET resolve assim que a BET chega.
- **Isolamento por item:** um erro num item nunca aborta a rodada nem trava os outros itens do lote.
  Erro transitório (`TransientInfrastructureError`): o item fica como está e volta quando o lease expira,
  sem gastar tentativa (`RETRY_LATER`). Qualquer outro erro é permanente: o item vira **FAILED**
  (`INTERNAL_INVARIANT_VIOLATION`, A16) numa transação própria, com log `error` e métrica, e os seus
  dependentes são acordados. Sem isso, um item com defeito seria reclamado de novo a cada lease e, por
  estar sempre primeiro na ordem, deixaria o resto do lote preso.
- **Wake-up × lease:** um wake-up pode adiantar um item que está com lease. É seguro: o processamento
  por item recheca o status sob o lock da wallet, e no máximo um worker aplica o efeito.
- **REFUND e ROLLBACK pendentes sobre a mesma BET:** são resolvidos em sequência sob o lock da wallet. O
  primeiro é aplicado e o segundo vê a reversão (`REFERENCE_ALREADY_REVERSED`), coberto também pelo
  índice único parcial.
- **Testes:** dependente chegando antes da referência por HTTP e por SQS, a cascata, o esgotamento, dois
  workers concorrentes sobre 40 pendências (20 PROCESSED e 20 REJECTED, exatamente um evento terminal por
  transação) e a expiração do lease, além do isolamento: erro permanente → FAILED só naquele item e o
  resto do lote aplicado; erro transitório → só aquele item adiado, sem gastar tentativa.

### 9.5 Múltiplas instâncias, crash e restart (§5, §8, §10, §11, §13)

Uma **instância** (A31) é um processo `bun run start`. A env `ROLES` (`api,consumer,publisher,pending-worker`,
todos por padrão) separa os papéis para escalar cada um. Nenhum papel guarda estado em memória: toda
coordenação passa pelo PostgreSQL (lock de linha da wallet, `SKIP LOCKED`, constraints únicas, inbox).

Provas com **processos reais** (`test/concurrency/*`, 3 instâncias com todos os papéis, mesmo banco e
mesmas filas):

| Cenário | Verificação |
|---|---|
| §8 entre instâncias (10×), as duas BETs em instâncias diferentes | 201 + 422, saldo 20.00, 1 DEBIT |
| §8 com uma BET por HTTP e a outra por SQS ao mesmo tempo (5×) | 1 PROCESSED + 1 `INSUFFICIENT_FUNDS` |
| A mesma BET 50×: 30 por HTTP em round-robin + 20 por SQS com grupos aleatórios | 1 débito; no máximo um 201 (o vencedor pode ter vindo pela fila); o resto replay com o mesmo `transactionId` |
| Carga mista em 20 wallets, com referências chegando por canais diferentes (fora de ordem) | reconciliação `consistent: true` em todas pela API, saldo exato, nada pendente ou FAILED, todos os eventos da outbox entregues |
| **Crash depois do commit e antes do ack:** a instância 1 é a única consumidora e faz SIGKILL em si mesma no fault point | commit completo (tx, ledger, inbox, outbox) sem ack; outras 2 instâncias recebem a reentrega, a inbox a reconhece (`DUPLICATE_MESSAGE`), fazem ack, publicam os eventos; 1 débito |
| **Restart:** SIGKILL nas 3 instâncias com cerca de 20% da carga commitada (HTTP + SQS com referências fora de ordem), restart, o provedor reenvia as requisições HTTP sem resposta | exatamente 1 transação por comando, todas terminais; reconciliação consistente em todas as wallets; outbox 100% publicada e entregue; DLQ vazia; nenhuma PENDING_REFERENCE sobrando |

- **Lease órfão:** o teste de restart expôs o caso em que um worker morto tinha acabado de fazer o claim de
  itens já acordados. Eles ficam reservados até o lease vencer, e só então outro worker os resolve
  (correto, mas atrasa). Por isso o default de `PENDING_REF_LEASE_MS` caiu de 30s para 10s: o
  processamento de um lote leva bem menos de 1s. O teste usa 2s e exige que nada fique pendente no fim.
- **Estabilidade:** a suíte de concorrência rodou 3 vezes seguidas sem falha, nenhum processo órfão
  (conferido por PID), e cada execução leva cerca de 90s.

## 10. Autenticação

**Decisão:** não implementar. Autenticação não vale pontos (§2, §14) e não deve competir com
correção financeira. O ponto de extensão, porém, está **ligado e testado**:

- `ProviderIdentityPort.resolve(credentials) → ProviderIdentity { subject, providerIds }` (porta de aplicação).
- `AuthGuard` global (Nest) resolve a identidade e a anexa à requisição. `@Public()` libera
  `/health/*` e `/metrics`.
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

### 11.1 Logs estruturados (§12)

- **Formato:** pino, uma linha JSON por evento em stdout: `time` (ISO-8601), `level` (texto), `service`,
  `pid`, `msg`, `component` e os campos do evento.
- **Contexto da unidade de trabalho** (`AsyncLocalStorage`, `observability/log-context.ts`), injetado em
  toda linha pelo `mixin` do pino, sem passar logger pelos use cases:
  - HTTP: `correlationId` (`X-Correlation-Id` recebido, se bem formado, ou gerado, e devolvido no header).
    Os controllers acrescentam `providerId`, `walletId`, `transactionId`, `txStatus`, `failureCode` e
    `idempotentReplay`. Ao terminar, cada requisição gera **uma** linha `http request` com método, rota
    (template), status e duração (health e `/metrics` em debug; 5xx em error).
  - SQS: cada mensagem roda no seu contexto com `sqsMessageId`, `receiveCount`, `messageId` (do envelope),
    `correlationId` (do envelope, ou o `messageId`), `walletId`, `providerId` e, depois do use case,
    `transactionId`. Linhas `message processed` / `transient failure…` / `message moved to the DLQ`.
  - Worker: `pending reference resolved` com `transactionId`, `walletId`, `providerId` e `resolution`
    (PROCESSED/REJECTED; as reavaliações que continuam pendentes ficam em debug). Um item com erro gera
    `pending reference failed permanently…` (error) ou `…deferred after a transient failure` (warn).
- **Sem dados sensíveis:** o código registra só identificadores e resultados. Como rede de segurança, o
  `redact` do pino censura `amount`, `balance`, `money`, `initialBalance`, `resultingBalance`,
  `storedBalance`, `calculatedBalance`, `difference`, `balanceBefore`, `balanceAfter`, `payload`, `body` e
  `data` em até 3 níveis. Erros de domínio são registrados só por `errorName`/`errorCode` (`errorFields`):
  as mensagens deles podem citar saldo ou o valor rejeitado (ex.: `InsufficientFundsError`). Erros de
  infraestrutura mantêm a mensagem. O `failureReason` de uma mensagem enviada à DLQ vai só nos atributos
  da mensagem, nunca no log.
- **Prova** (`test/integration/observability/logging.test.ts`): com o stream capturado, um roteiro com
  HTTP (201, replay 200, 422, 400), SQS e worker verifica os identificadores em cada linha e que **nenhum**
  dos valores monetários usados (escolhidos para serem únicos) aparece no texto bruto. A redaction é
  testada à parte.

### 11.2 Métricas (§12)

`GET /metrics` (aberto, formato Prometheus). Os use cases reportam fatos de domínio pela porta `Metrics`
(`application/ports/metrics.ts`, no-op por padrão), e `PromMetrics` (prom-client) os exporta. Há um
`Registry` por container, sem estado global, para vários runtimes conviverem num processo de teste.

| Métrica (§12) | Tipo e rótulos | Onde é medida |
|---|---|---|
| Transações por status | `wagering_transactions_total{kind,status,channel}` | submissão (HTTP/SQS, incluindo FAILED), worker (WORKER), abertura de wallet (OPENING) |
| Duplicatas detectadas | `idempotent_replays_total{channel}`, `idempotency_conflicts_total{reason}`, `inbox_duplicates_total{consumer}` | replay idempotente, conflito 409/DLQ, reentrega reconhecida pela inbox |
| Retries | `retries_total{component,reason}` | `db_transaction` (retry no lugar por deadlock/serialização/versão), `consumer` (`ChangeMessageVisibility`), `outbox` (falha de publicação), `pending_reference` (reagendamento) |
| Mensagens em DLQ | `dlq_messages_total{reason}` + gauge `dlq_depth` | contador por processo; profundidade lida da SQS no scrape |
| Conflitos de lock (A30) | histograma `wallet_lock_wait_seconds` + `wallet_lock_conflicts_total{type}` | espera no `FOR UPDATE` da wallet; `lock_timeout`/`deadlock`/`serialization`/`version_conflict` vindos do `TransactionRunner` |
| Outbox lag | gauges `outbox_pending` e `outbox_lag_seconds` + `outbox_published_total` | pendentes e idade da mais antiga lidos do PostgreSQL no scrape (estado global) |
| Latência de processamento | histograma `wagering_processing_duration_seconds{channel}` | submissão inteira (HTTP e SQS) e resolução no worker |
| Divergência de reconciliação | `reconciliation_divergences_total` | §7.4 |
| Wallet inexistente pela SQS (A9) | `unknown_wallet_messages_total{consumer}` | mensagem registrada na inbox e confirmada sem transação |

Também entram as métricas padrão de processo (`collectDefaultMetrics`: CPU, memória, event loop lag).
Os gauges globais têm timeout de 2s: com o banco ou a fila fora do ar, o scrape não trava e o gauge mantém
o último valor. **Prova:** `test/integration/observability/metrics.test.ts` executa um roteiro (wallet,
BET, replay, conflito, 422, pendência resolvida pelo worker, mensagem SQS com uma falha transitória e uma
reentrega, envelope inválido, `lock_timeout`) e confere cada incremento.

Sugestão de alertas: `outbox_lag_seconds > 60`, `increase(dlq_messages_total[5m]) > 0`,
`increase(reconciliation_divergences_total[5m]) > 0` (crítico) e p99 de `wallet_lock_wait_seconds` > 1s
(hot wallet).

### 11.3 CI

`.github/workflows/ci.yml` roda em `ubuntu-24.04`, com **PostgreSQL 16.15** e **LocalStack 4.14.0** como
services, em todo push e em PR para a `main`:

1. Bun fixado (`oven-sh/setup-bun` 1.3.14), com uma etapa que falha se não for a versão do
   `packageManager` do `package.json`.
2. `bun install --frozen-lockfile`.
3. `max_connections = 300` (como no compose): services não aceitam argumentos de comando, então a etapa
   usa `ALTER SYSTEM` e reinicia o container do service.
4. Caminho do README: `migration:up` → `migration:down` → `migration:up` → `sqs:setup`.
5. `typecheck`, `test:unit`, `test:integration` e `test:concurrency` em etapas separadas.
6. Smoke: `bun src/main.ts` com todos os papéis, `/health/ready` e `/metrics`, depois `kill -TERM`. Exige
   exit 0 e as linhas `"signal":"SIGTERM"` e `runtime stopped` no log.

O CI valida em Linux o caminho de **SIGTERM real**, que no Windows não pode ser testado (§9.2): o harness
de processos usa `kill("SIGTERM")` fora do Windows, inclusive no teste do consumidor com mensagem em
andamento. O primeiro run em Linux passou sem nenhuma correção específica de plataforma (unidade 245 em
0,1s, integração 179 em 71s, concorrência 17 em 51s).

## 12. Trade-offs e limitações

**Trade-offs escolhidos conscientemente**

- **Lock pessimista por wallet** (§6.1): latência estável em hot wallets em troca de throughput serializado
  por wallet. Uma wallet processa uma operação por vez; wallets diferentes escalam em paralelo.
- **Lock da outbox segurado durante o envio ao broker** (§9.3): nenhum publisher pega a mesma linha, em troca
  de transações que duram o envio (com timeout de 5s e `idle_in_transaction_session_timeout`).
- **At-least-once em toda a mensageria:** a outbox pode republicar e o consumidor pode receber de novo.
  A deduplicação é sempre por `eventId`/`messageId` no banco, nunca por "exactly-once" do broker.
- **Checagens redundantes** (código + constraint + trigger): mais escrita por transação (trigger deferred
  saldo ⇔ ledger), em troca de garantias que valem mesmo para um bug ou uma escrita manual.
- **REFUND/ROLLBACK de BET com WIN é permitido** (A6): segue a spec literalmente. O provedor deve reverter
  o WIN antes. É um risco de negócio documentado, não uma regra inventada.

**Limitações conhecidas**

- **Moedas só com escala 2** (A3): JPY (0 casas) e KWD (3 casas) ficam fora de escopo.
- **Outbox e inbox sem retenção/limpeza** (A29): as tabelas crescem. Em produção: job de expurgo das linhas
  publicadas/processadas há mais de N dias, ou particionamento por data.
- **DLQ sem redrive automatizado:** o reprocessamento é manual (`StartMessageMoveTask` ou reenvio). É seguro
  graças à inbox e à idempotência.
- **Reconciliação sob demanda:** não há um job periódico; a métrica e o log disparam quando alguém chama o
  endpoint. Em produção: um agendamento varrendo as wallets ativas.
- **Throughput FIFO:** filas FIFO da AWS têm cota de throughput por fila (maior em lote e no modo
  *high throughput*, que distribui por `MessageGroupId`). Não foi medido aqui: o LocalStack não impõe essas
  cotas. Com `MessageGroupId = walletId` (A26), a ordenação do broker coincide com a serialização por
  wallet, e a correção não depende dela.
- **Sem autenticação** (§10): só o ponto de extensão (`ProviderIdentityPort` + `AuthGuard` no-op).
- **Um único PostgreSQL:** sem sharding nem réplicas de leitura. As consultas leem do primário.
- **CPU por submissão (driver `pg` no Bun):** 8 a 16 ms de CPU por requisição, gastos principalmente
  esperando o banco (§6.2, `docs/LOAD-TEST.md`). Uma instância chega a ~190 req/s num runner Linux de 4
  vCPUs. **3 instâncias no mesmo host não aumentam o throughput** (o host satura), e a hot wallet degrada
  (p99 de ~6,5 s com 64 clientes). Melhorias, por impacto: `Bun.SQL` no hot path, menos round-trips por
  submissão e afinidade por wallet. A escala em hosts separados não foi medida.
- **Inbox no fallback 23505:** quando duas mensagens diferentes (`messageId`s distintos) com a mesma
  Idempotency-Key correm em paralelo e a perdedora cai no fallback de violação única, a transação dela faz
  rollback (inclusive a linha da inbox), e o resultado vira replay e ack. A inbox não registra esse
  `messageId`. Se ele for reentregue, cai de novo na idempotência e gera outro replay: correto, só não
  passa pelo fast path da inbox.
- **Sem heartbeat de visibilidade:** o processamento de uma mensagem é limitado por `lock_timeout` (5s),
  `statement_timeout` (10s) e até 3 retries internos, bem abaixo do visibility timeout de 30s. Uma
  mensagem que ainda assim passe do timeout é reentregue, e a inbox a deduplica.

## 13. Revisão final independente

Um revisor que não participou da implementação conferiu, item por item, §5 (restrições invioláveis), §13
(testes obrigatórios) e §14 (falhas eliminatórias) contra o código e o corpo dos testes. **Veredito:
nenhum item violado; todos os eliminatórios cumpridos.** Os 6 achados de força de prova e de
endurecimento foram corrigidos:

| # | Achado | Correção |
|---|---|---|
| 1 | Atomicidade pela SQS só testada com falha **antes** das escritas financeiras | `consumer.test.ts` › `atomicity: a crash %s…` agora cobre `consumer:after-inbox-insert`, `submit:after-ledger-insert` e `submit:before-outbox-insert`: inbox, transação, ledger, wallet (saldo e versão) e outbox voltam juntos, e a reentrega aplica uma única vez |
| 2 | Runtime conectava como superusuário dono do schema (poderia desligar triggers) | role `wagering_app` de menor privilégio (§5.2), com teste provando `42501` em `DISABLE TRIGGER`, `session_replication_role`, `UPDATE/DELETE/TRUNCATE` no ledger e DDL |
| 3 | Testes "fora de ordem" concorrentes não exigiam que o caminho ocorresse | `hot-wallet`, `multi-instance › mixed load` e `restart-recovery` exigem `WagerTransactionPendingReference > 0` |
| 4 | Invariante final não rodava ao fim de **todo** teste | `afterEach(assertLedgerInvariant)` em todos os arquivos que tocam wallets. Exceções explícitas e comentadas: `sqs.test` (sem banco), `migrations.test` (só schema), "PostgreSQL inacessível" (sem banco) e as wallets corrompidas de propósito em `reconciliation-divergence` |
| 5 | Schema não amarrava o lançamento à transação | trigger `ledger_check_transaction` (§5.2), com 5 testes de constraint |
| 6 | Centavos sorteados com aritmética `number` em 2 testes | PRNG em `bigint` (`test/support/random.ts`); `audit:money` passou a detectar `BigInt(Math.…)`/`BigInt(… * …)` e variáveis `cents` |

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
| A7 | Referência não terminal ou falha | Referência em PENDING_REFERENCE → o dependente também espera, **sem gastar tentativas**, até a referência ficar terminal. Referência REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`. |
| A8 | Payload estruturalmente inválido | 400 sem persistir: BET com referência, autorreferência, kind OPENING, providerId reservado `internal`. |
| A9 | Wallet inexistente | HTTP 404 `WALLET_NOT_FOUND` sem consumir a key. Na SQS: erro de negócio terminal (inbox + ack + `unknown_wallet_messages_total`). |
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
| A21 | Corpos não-201 | 202 e replays no formato de sucesso (`balance: null` se pendente); 422 e 500 (FAILED) no formato de erro, com `failureCode` explícito; na 422, `code` repete o `failureCode`. |
| A22 | Identificadores | `walletId` UUID; os demais ids são ASCII imprimível sem espaço, 1–128 caracteres. |
| A23 | Provedores | Sem registro de provedores; `internal` é reservado. Autorização via `ProviderIdentityPort` (no-op). |

### Mensageria e operação

| Id | Tema | Interpretação adotada |
|---|---|---|
| A24 | Fila de eventos | `wagering-events.fifo`, `MessageGroupId = aggregateId` (a wallet, para `WalletBalanceChanged`), `MessageDeduplicationId = eventId`. Consumidores usam `walletVersion` e `eventId`, não a ordem. |
| A25 | Consumidor de eventos | Consumidor de auditoria (teste) com inbox (`consumerName = events-audit`, `messageId = eventId`). |
| A26 | `MessageGroupId` de entrada | Produtor deveria usar `walletId`, mas a correção não depende disso (testes usam groups aleatórios). |
| A27 | Erros no consumidor | Negócio → ack. Transitório → `ChangeMessageVisibility` com backoff. Permanente → DLQ imediata. Limite de recebimentos na aplicação + redrive como rede de segurança. Detalhe em §9. |
| A28 | Limites de PENDING_REFERENCE | 10 tentativas, base 2s, fator 2, cap 5 min (configurável), gastas só enquanto a referência não existe. Wake-up imediato dos dependentes quando a referência fica terminal (PROCESSED, REJECTED ou FAILED). |
| A29 | Outbox | Sem limite de tentativas; backoff 1s→60s com jitter. Retenção/limpeza fora de escopo. |
| A30 | Métrica de conflito de lock | Histograma de espera de lock + contadores de `lock_timeout`, deadlock e version mismatch. |
| A31 | Instância | Um processo `bun run start`; `ROLES` separa API, consumidor, publisher e worker. |
| A32 | Timeouts | `lock_timeout` 5s, `statement_timeout` 10s; deadlock/serialização com até 3 retries e jitter; depois, 503. |
