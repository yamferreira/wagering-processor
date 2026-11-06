# Teste de carga: 1 instância × 3 instâncias

`bun run test:load` (código em `test/load/load.ts`) gera um relatório em `reports/load-<timestamp>.md`.
Os números abaixo vêm de duas execuções completas: uma no notebook de desenvolvimento (Windows) e uma no
CI (Linux, job `load`, com o relatório publicado como artefato). **Não há meta de RPS.** O objetivo foi
entender onde está o gargalo e o que acontece com a consistência sob carga.

## Ambiente

| | Local (Windows) | CI (Linux) |
|---|---|---|
| Máquina | Ryzen 5 4600H, 6 núcleos / 12 threads, 7,4 GiB | GitHub runner `ubuntu-24.04`, AMD EPYC 7763, 4 vCPUs, 15,6 GiB |
| Software | Bun 1.3.14, PostgreSQL 16.15, LocalStack 4.14.0 (Docker Desktop) | Bun 1.3.14, PostgreSQL 16.15, LocalStack 4.14.0 (services) |
| Onde roda cada coisa | **tudo no mesmo host**: gerador de carga, instâncias, PostgreSQL, LocalStack | idem |

## Metodologia

- Para cada cenário: banco novo e filas novas, e N instâncias reais (`bun src/main.ts`, todos os papéis:
  api, consumer, publisher, pending-worker, pool de 20 conexões cada, `LOG_LEVEL=warn`).
- 200 wallets + 1 **hot wallet**, com saldo alto o bastante para nenhuma BET ser rejeitada (o objetivo é medir
  o caminho de sucesso, não as rejeições).
- Carga HTTP em **laço fechado**: N clientes concorrentes, round-robin entre as instâncias, com keep-alive.
  Mistura: 10% de BET na hot wallet, ~5% de replays idempotentes de BETs anteriores, ~20% de WIN
  referenciando uma BET já confirmada e o resto BET numa wallet aleatória.
- 3s de aquecimento descartados e 20s medidos. A latência é medida no cliente.
- Do lado servidor: delta de `/metrics` de cada instância (CPU do processo, histograma de espera do lock,
  conflitos de lock, retries) e outbox lag/pendentes amostrados a cada 1s. Também a CPU do host inteiro e a
  do gerador.
- No fim: tempo até a outbox ficar 100% publicada e o invariante saldo ⇔ ledger checado para todas as wallets.
- **Sonda de driver:** `SELECT 1` sequencial, no mesmo processo, pelo MikroORM (driver `pg`) e pelo `Bun.SQL`
  nativo (`test/load/driver-probe.ts`).

## Resultados

### CI (Linux, 4 vCPUs)

| | 1 inst × 8 | 3 inst × 8 | 1 inst × 64 | 3 inst × 64 |
|---|---|---|---|---|
| Throughput (req/s) | **186** | 168 | **197** | 171 |
| Latência p50 / p95 / p99 (ms) | 41 / 73 / 89 | 43 / 91 / 117 | 291 / 628 / 894 | 129 / 2051 / 3755 |
| Hot wallet p50 / p99 (ms) | 47 / 108 | 50 / 126 | 619 / 1146 | 1931 / **6788** |
| Erros (5xx + rede) | 0% | 0% | 0% | 0% |
| CPU do host | 71% | 94% | 71% | 95% |
| CPU por instância (núcleos) | 1,52 | 0,93 × 3 | 1,54 | 0,90 × 3 |
| CPU do servidor por requisição | **8,2 ms** | 16,6 ms | **7,8 ms** | 15,8 ms |
| Espera de lock média / p99 | 4 ms / ≤50 | 5 ms / ≤50 | 40 ms / ≤1000 | 220 ms / ≤5000 |
| Conflitos de lock / retries no banco | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Outbox lag máximo / dreno depois da carga | 0,35 s / 0,27 s | 0,29 s / 0,27 s | 0,42 s / 0,27 s | 0,40 s / 0,27 s |
| Lançamentos no ledger / divergências | 4086 / **0** | 3723 / **0** | 4514 / **0** | 3879 / **0** |

Sonda (Linux): MikroORM/pg **0,34 ms de wall e 0,45 ms de CPU** por round-trip; Bun.SQL 0,19 ms de wall e
0,14 ms de CPU.

### Local (Windows, 6 núcleos / 12 threads)

| | 1 inst × 8 | 3 inst × 8 | 1 inst × 64 | 3 inst × 64 |
|---|---|---|---|---|
| Throughput (req/s) | 98 | 125 | 105 | 127 |
| Latência p50 / p95 / p99 (ms) | 80 / 119 / 151 | 61 / 104 / 131 | 585 / 782 / 1152 | 191 / 2954 / 5338 |
| Hot wallet p50 / p99 (ms) | 88 / 223 | 74 / 188 | 809 / 1693 | 3054 / **6380** |
| Erros (5xx + rede) | 0% | 0% | 0% | 0% |
| CPU do host | 39% | 68% | 38% | 74% |
| CPU por instância (núcleos) | 1,75 | 1,44 × 3 | 1,62 | 1,48 × 3 |
| CPU do servidor por requisição | 17,9 ms | 35,0 ms | 15,4 ms | 35,0 ms |
| Espera de lock média | 8 ms | 7 ms | 41 ms | 278 ms |
| Conflitos de lock / retries no banco | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Outbox lag máximo / dreno | 0,44 s / 0,30 s | 0,29 s / 0,30 s | 1,17 s / 0,29 s | 0,28 s / 0,08 s |
| Divergências | 0 | 0 | 0 | 0 |

Sonda (Windows): MikroORM/pg cerca de 1,0 ms de wall e 0,8 a 1,0 ms de CPU por round-trip; Bun.SQL 0,7 ms
de wall e 0,05 a 0,5 ms de CPU (a medição oscila entre execuções).

## Análise

**1. Uma instância é limitada por CPU, e quase toda essa CPU é gasta esperando o banco.** Uma submissão
faz cerca de 12 round-trips ao PostgreSQL (BEGIN, `set_config`, lock da wallet, duas leituras de
idempotência, referência e reversão, insert da transação, ledger, update da wallet, outbox, wake-up e
COMMIT). Pelo driver `pg` no Bun, cada round-trip consome **tanta CPU quanto dura** (CPU ≥ wall na sonda,
nos dois sistemas): o processo fica ocupado enquanto espera, em vez de dormir no event loop. O `Bun.SQL`
nativo gasta menos CPU pelo mesmo round-trip: cerca de 3× menos no Linux e de ~2× a ~20× menos no Windows,
onde a medição oscila. Daí os ~8 ms (Linux) e ~16 ms (Windows) de
CPU por requisição. O throughput de uma instância é ≈ núcleos ocupados ÷ CPU por requisição:
1,5 ÷ 8 ms ≈ 190 req/s no Linux, que é o medido.

> **O custo não é do ORM.** A hipótese natural seria atribuir os "~10 ms de CPU por submissão" ao
> trabalho do ORM (fork, montagem de queries, hidratação). A sonda mostra que o custo
> dominante é a espera ativa do driver durante os round-trips. Isso também explica por que a CPU por
> operação varia com o paralelismo (32 ms sequencial e ~10 ms com 40 em paralelo, quando as esperas se
> sobrepõem): é custo por *espera*, não por *instrução*.

**2. Três instâncias no mesmo host não aumentam o throughput.** No Linux (4 vCPUs) o throughput caiu
cerca de 10%. No Windows (6 núcleos / 12 threads) subiu só cerca de 25%, longe de 3×. Em ambos, a CPU por
requisição **dobra** com 3 instâncias: cada processo gasta a sua CPU nas próprias esperas, e todos disputam
os mesmos núcleos com o PostgreSQL, o LocalStack e o gerador (o host vai a 95% no Linux). O experimento
**não mede** o ganho de escalar em hosts separados, onde cada instância teria a própria CPU e o próximo
gargalo provável seria o PostgreSQL. Isso fica como não verificado. O que as 3 instâncias provam aqui é
correção e disponibilidade (§9.5), não throughput.

**3. A hot wallet é o ponto fraco, e piora com mais instâncias.** O lock por wallet serializa por desenho:
10% do tráfego disputa uma única linha. Com 64 clientes e 3 instâncias, o p99 da hot wallet chega a 6,4 a
6,8 s (contra 1,1 a 1,7 s com 1 instância). Há mais transações esperando a mesma linha ao mesmo tempo (até
60 conexões, contra 20), e quem segura o lock está num processo sem CPU, então demora mais entre um
statement e outro e o lock fica preso por mais tempo. Não houve `lock_timeout` (5 s), mas a margem é pequena.
As wallets comuns quase não sentem: a espera média de lock fica em ~4 a 8 ms com 8 clientes.

**4. Correção sob carga.** Em todos os cenários e nos dois sistemas: **0 erros, 0 conflitos de lock, 0
retries de deadlock/serialização** e **0 divergências** saldo ⇔ ledger (cerca de 27 mil lançamentos ao
todo). A outbox nunca acumulou mais de ~220 eventos (lag ≤ 1,2 s) e ficou 100% publicada menos de 0,3 s
depois do fim da carga. Os replays idempotentes são os mais baratos (p50 de 7 a 12 ms com carga baixa): o
fast path é uma leitura, sem lock.

## Próximos passos (por impacto)

1. **Trocar o driver do hot path:** usar `Bun.SQL` (ou outro driver sem espera ativa) nas cerca de 12
   instruções da submissão, mantendo o MikroORM para o resto. Pela sonda, a CPU por round-trip cai de ~2× a
   ~20× (cerca de 3× no Linux). É o maior ganho disponível.
2. **Menos round-trips por submissão:** juntar as duas leituras de idempotência numa só, juntar
   `set_config` e lock no mesmo statement, e fazer ledger + update da wallet num único CTE.
3. **Afinidade por wallet para hot wallets:** rotear uma wallet sempre para a mesma instância (hash
   consistente no balanceador; na SQS, `MessageGroupId = walletId` já faz isso) e limitar a concorrência
   por wallet na borda. Isso reduz a fila no lock sem mudar a garantia, que continua no banco.
4. **Medir de verdade a escala horizontal:** instâncias em hosts separados e um gerador fora deles, para
   achar o próximo gargalo (provavelmente o PostgreSQL: conexões, WAL e a escrita do trigger deferred).

## Limitações do experimento

- Uma execução por cenário (sem repetições nem intervalo de confiança), com janelas de 20 s.
- Tudo no mesmo host, inclusive o gerador (que usa só 0,12 a 0,3 núcleo).
- Só a entrada HTTP foi posta sob carga; a SQS foi validada em correção (suítes de integração e
  concorrência), não em throughput. O LocalStack não reproduz a latência nem as cotas da SQS real.
- `LOG_LEVEL=warn`: o custo de logar cada requisição em `info` não entrou na medição.
