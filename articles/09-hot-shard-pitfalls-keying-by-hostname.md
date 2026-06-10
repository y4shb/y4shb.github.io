# Hot-shard pitfalls when you key by hostname

*what happens when one host's traffic surges and your evenly-split topic stops being even*

Last Tuesday at 14:07, `host-prod-a-1471` started emitting 20 times its usual event volume. Nothing else changed: same topic, same producer code, same consumer group. By 14:09 one partition out of 24 carried 70% of the bytes, and the per-host state machine reading that partition fell three minutes behind and kept falling. A state machine here is just code that tracks each host's status (healthy, degraded, silent) as events arrive. That uneven load is "skew": a few keys carrying far more than their share.

Some terms first. A **partition** is one of the parallel logs a Kafka topic is split into; it is the unit of both storage and parallelism. A message's **key** decides which partition it lands in. A **consumer group** is a set of consumer processes that share the work of reading a topic, and the rule that matters: within a group, each partition is read by exactly one consumer. "Draining" a partition means reading and processing its messages. Kafka only guarantees order *within* a partition, so to process all of one host's events in order on one thread, you key on hostname so they all land in one partition. That same rule means a single overloaded partition cannot be split across consumers, which is what makes this hard.

## Why people reach for hostname keying

The appeal of routing by key is per-key ordering: every event from `host-prod-a-1471` lands in the same partition, so you process them in produce order (the order the producer sent them) on a single thread. That buys you per-host state machines, sequence-number deduplication (removing duplicate events by comparing a per-event sequence number, often shortened to dedup), and incremental aggregation, with no cross-consumer coordination. The producer code is one line.

```python
producer.send(
    topic="host-events",
    key=event["hostname"].encode(),
    value=json.dumps(event).encode(),
)
```

How the partition gets chosen: Kafka's `DefaultPartitioner` runs the key bytes through murmur2, a fast non-cryptographic hash (chosen for speed and even spread, not security), then takes that hash modulo the partition count. Modulo means the remainder after dividing: the same `%` operator you know from code. The full expression is `toPositive(Utils.murmur2(keyBytes)) % numPartitions`, where `toPositive` wraps a possibly-negative hash into a non-negative index between 0 and `numPartitions - 1` (see the [DefaultPartitioner source](https://github.com/apache/kafka/blob/3.2.0/clients/src/main/java/org/apache/kafka/clients/producer/internals/DefaultPartitioner.java); librdkafka uses the same scheme for `partitioner=murmur2_random`). The same key always hashes to the same partition.

A good hash spreads keys evenly regardless of what the names look like, so name distribution is not what you worry about. What keeps partitions balanced is the *traffic per host* being roughly even. If no host is dramatically chattier than the rest, the streams smooth out.

## When the traffic stops being even

You have 24 partitions and 4,000 hosts. Each partition gets traffic from ~165 hosts, so the average smooths out. To put a number on "balanced", rank the partitions by throughput (events or bytes processed per second) and compare the busiest to the median, the middle one when you sort them. The busiest sits maybe 1.4x the median. A small ratio means load is even and nothing pages the on-call team.

Three plausible scenarios break this:

1. **A regression storm.** Someone merges a firmware change. On any host where it loads, a driver fault loop kicks in and the host emits 5,000 errors per second instead of the normal 5. Twenty hosts are now 1,000x noisier than the rest, spread across maybe twelve partitions, but the four that got multiple noisy hosts now carry 80% of the topic's bytes.

2. **A long-running batch job.** A pricing team kicks off a 48-hour reindex on a beefy box called `svc-pricing-12`. The job emits an audit event per row, and the partition holding `svc-pricing-12` carries one host at a rate higher than the other 23 combined.

3. **Naming convention drift.** Someone deploys a fleet of identical short-lived workers all named `worker-pool-a`. Thousands of distinct machines now emit under one key, so the hash maps every one to a single partition. Cardinality is the number of distinct values a key takes; here it collapsed from thousands of machines down to one name, so all that traffic shares one partition. The hash is behaving correctly; the inputs collapsed.

In every one, the partition count, the hash, and the consumer hardware are all fine. The problem is the data distribution.

## Spotting the overloaded partition

Two terms get used interchangeably but should not be. A **hot partition** carries far more than its share of traffic. A **hot key** is a single key carrying far more than its share of one partition's traffic. The fixes diverge: a hot partition from many noisy keys can be relieved by spreading keys, but one from a single hot key cannot, since that key is pinned to one partition.

The first sign is almost never "partition X is hot," but "consumer lag is rising on group Y." Consumer lag is how far behind a consumer is from the newest message in a partition, measured in messages. Per-partition lag shows it is concentrated, so your dashboard has to break lag out per partition. Watch only the aggregate and you mistake a hot-shard problem for "consumer too slow," then scale up a consumer that was never the bottleneck.

Useful broker-side metrics, roughly most useful first. Kafka exposes these over JMX (Java Management Extensions, the interface brokers offer for reading metrics and management data). Each metric is an MBean, a named object you query by the dotted string below. A "delta" is the difference between two samples of the same number over time.

- Per-partition produce rate. The stock JMX MBean `kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec,topic=X` is per-topic, with no per-partition variant. To get per-partition `BytesIn` you either compute log-dir size deltas (`kafka.log:type=Log,name=Size,topic=X,partition=Y` sampled over time) or run a custom collector that diffs per-partition end offsets. The end offset is the offset just past the newest message; an offset is a message's sequential position in its partition, starting at zero.
- `MessagesInPerSec` per topic, paired with per-partition end-offset deltas (how much the end offset moved between samples) to separate "one giant event" from "a flood of small ones."
- Per-partition consumer lag (records, not bytes), via `kafka-consumer-groups.sh --describe` or `kafka.consumer:type=consumer-fetch-manager-metrics,name=records-lag,...`. This is the metric that pages the on-call team.
- Producer-side key distribution. Sample produced keys for a minute and build a histogram; one dominating key is immediately visible.

Confirming the hot key from the consumer side:

```python
from collections import Counter

counts = Counter()
for msg in consumer.poll(timeout_ms=5000).values():
    for record in msg:
        counts[record.key] += 1

for key, n in counts.most_common(10):
    print(f"{key!r}: {n}")
```

If the top key is doing 60% of the partition's volume, you have a hot key, not a hot partition, and the two need different fixes.

## The three things you will try first, and why they all make it worse

When the page fires, the urge is to redistribute. Three common moves all backfire.

**Add partitions.** Kafka lets you increase partition count on a topic, and this is worse than it sounds because of the modulo: `hash(K) % 24` and `hash(K) % 48` are two unrelated remainders of the same number, so doubling the count reshuffles where nearly every key lands. For keyed messages using the default hash-mod partitioning, Confluent is explicit that increasing partitions does not redistribute existing data and that new writes with the same key may land on a different partition, breaking per-key affinity at the boundary ([Kafka partition determination docs](https://docs.confluent.io/kafka/operations-tools/partition-determination.html)). Concretely:

```
key K = "host-prod-a-1471"
murmur2(K) = 0x9F3A12C7

before alter (24 partitions):   hash(K) % 24 = 5     -> all history on P5
after  alter (48 partitions):   hash(K) % 48 = 19    -> new writes on P19

P5  [...older offsets, now stranded for ordering purposes...]
P19 [new offsets, no idea P5 exists]
```

Old messages stay on partition 5, new ones land on 19, and you have lost per-key ordering at the boundary for every key in the topic. The hot key just moves to a new partition. Even a full repartition (new topic, mirror data over) only helps if your hot keys spread across the new space; if the noise is one host, that host still goes to a single partition.

**Add consumers.** A single Kafka partition is consumed by exactly one consumer in a group. Run 200 consumers and the hot partition is still drained by one; the other 199 have no partition to read and sit idle.

**Switch to round-robin keying.** This does flatten the partitions. It also destroys per-host ordering, the entire reason you chose hostname-keying. If your consumer assumes ordered per-host events (it almost certainly does, even if nobody wrote that down), you have a bug that stays invisible until a customer complains about a reordered transition.

## What actually works

Three patterns help, in roughly increasing order of complexity:

### 1. Composite keys

If `hostname` alone is too coarse, key by `(hostname, secondary_dimension)` where the second dimension splits the chatty host's traffic without breaking the ordering you need.

The classic example: error events from a single host often cluster around a specific subsystem. If `svc-pricing-12` emits 5,000 events per second across 20 subsystems, then `(hostname, subsystem)` keys give you 20 distinct keys instead of 1. Hash collisions collapse some onto the same partition, but you no longer pin all 5,000 to a single shard.

```python
key = f"{event['hostname']}|{event['subsystem']}".encode()
producer.send(topic="host-events", key=key, value=...)
```

You have changed your ordering guarantee to per-(host, subsystem), not per-host. If your consumer does cross-subsystem state transitions per host, this breaks it. If not, you are fine.

A concrete failure mode: a consumer that maintains `last_seen[host]` across subsystems. Before composite keying, every event for `host-prod-a-1471` arrived on the same partition in produce order, so the consumer could write `last_seen["host-prod-a-1471"] = max(current, event.ts)` and trust it. After, `(host, subsystemA)` lands on P3 and `(host, subsystemB)` on P11, drained by two different threads. An event from subsystemA at t=100 and one from subsystemB at t=99 now arrive in either order, the `last_seen` writes interleave, and any logic that fires on a transition (alerting when a host goes silent, deduping on previous-state) gets non-deterministic answers. The bug class is "cross-key invariants on what used to be a single-key stream." It shows up in postmortems, not tests, because tests rarely interleave two partitions the way production does.

### 2. Salt-then-bucket

When you need per-host ordering most of the time but want a safety valve for pathological cases, salt the key with a small bounded fan-out. Fan-out means spreading one source's writes across several partitions.

```python
SALT_BUCKETS = 8

def partition_key(event):
    host = event["hostname"]
    # Most hosts get one bucket: deterministic, ordered.
    # Hot hosts get spread across N buckets.
    if host in HOT_HOSTS:
        bucket = random.randint(0, SALT_BUCKETS - 1)
        return f"{host}#{bucket}".encode()
    return host.encode()
```

The salted key still goes through the same `murmur2 % numPartitions`, so 8 salt buckets do not guarantee 8 distinct partitions; collisions can collapse some. This static version scatters every event from a hot host onto a random bucket, so use it only when consumers tolerate that scatter. `HOT_HOSTS` is a small set refreshed from your metrics. The trade: 99% of traffic gets clean per-host ordering, and the 1% of pathological hosts temporarily lose ordering.

A variant that works well makes the fan-out *rate-aware*, which is what lets it recover on its own. Instead of a static `HOT_HOSTS` list, every event gets `host#bucket(host, time_window)`, where the bucket is `0` for normal hosts and a hashed spread for hosts that crossed a rate threshold in the last minute. Here `rate_counter` is a shared sliding-window counter every producer reports into and reads back, so `rate_counter.get(host, window)` returns that host's fleet-wide event rate during the current window, not just what one producer saw. No config push needed:

```python
def bucket(host, now):
    window = now // 60  # 60-second rolling window
    rate = rate_counter.get(host, window)  # fleet-wide events/sec for this window
    if rate < HOT_THRESHOLD:
        return f"{host}#0"
    return f"{host}#{hash((host, window)) % SALT_BUCKETS}"
```

The `now // 60` quantizes time into fixed 60-second windows, so every event in the same minute computes the same `window` value and the salt stays stable for that minute. When the clock ticks into the next minute, `window` increments, changing the input to `hash((host, window))` and therefore the bucket. The salt is transient because its input changes every window.

```mermaid
stateDiagram-v2
    [*] --> Normal
    Normal --> Salted: rate >= threshold
    Salted --> Salted: still hot in window
    Salted --> Normal: next window, rate below threshold
    note right of Normal
        key = host#0
        ordered, single partition
    end note
    note right of Salted
        key = host#hash
        spread, ordering relaxed
    end note
```

Two caveats. First, this only recovers on its own if `rate_counter` reflects the host's true fleet-wide rate. A per-process counter sees only one producer instance's events, so a host hot across many producers but quiet on each never trips the threshold; the counter has to be shared for the "no config push" promise to hold. Second, the collapse back to bucket 0 holds only for *new writes*. Data written during the hot minute stays physically spread across `SALT_BUCKETS` until it ages out, so consumers must keep scanning all buckets for that window. That is why consumers reconcile on the host key, not the salted key.

### 3. Single partition, multiple consumer threads

Sometimes you cannot change the keying: downstream contracts, an unavailable consumer-owning team, or a topic shared with other services. You can still parallelize the drain: keep one Kafka consumer reading the hot partition and hand records off to a thread pool keyed by a sub-dimension you control. Keep the per-sub-key ordering and you recover throughput without touching the topic.

The hard part is when to commit your offsets, and it turns on what delivery guarantee you want. **At-least-once** means a record may be processed more than once but never lost; **exactly-once** means processed precisely once, which is far harder and not what this pattern gives you. A committed offset in Kafka is the *next* offset to read: committing N tells the broker "everything below N is done, resume at N." Commit naively after enqueueing and a crash loses records the workers never finished; commit the highest finished offset and a crash skips a lower one still in flight, since workers finish out of order.

The fix is a **watermark commit**. A watermark is the highest point below which everything is confirmed done. You keep a sorted set of in-flight offsets per partition and commit the smallest one still in flight on each tick. The sequence below shows the crash-replay path that makes this at-least-once, and why `process()` must be idempotent. Idempotent means safe to run more than once without changing the result.

```mermaid
sequenceDiagram
    participant P as Poll loop
    participant W as Worker pool
    participant C as Committer
    participant K as Kafka
    P->>W: enqueue offsets 100..104
    Note over W: 102 finishes first, 100 still running
    W-->>C: 102 done
    C->>K: commit 100 (smallest in-flight)
    Note over P,K: crash here
    K-->>P: resend from 100
    Note over W: 102 replays (idempotent process)
```

```python
import collections, threading, time
from queue import Queue
from sortedcontainers import SortedList  # pip install sortedcontainers

NUM_WORKERS = 16
queues = [Queue(maxsize=10_000) for _ in range(NUM_WORKERS)]

# Per-partition set of offsets still being processed.
inflight = collections.defaultdict(SortedList)
last_seen = {}                      # highest offset polled per partition
inflight_lock = threading.Lock()

def worker(q):
    while True:
        record = q.get()
        try:
            process(record)
        finally:
            with inflight_lock:
                inflight[record.partition].remove(record.offset)

for q in queues:
    threading.Thread(target=worker, args=(q,), daemon=True).start()

def committer():
    while True:
        time.sleep(1.0)
        commits = {}
        with inflight_lock:
            for p, last in last_seen.items():
                offsets = inflight[p]
                # Commit point = next offset to read.
                # If something is in flight, resume at the lowest in-flight offset.
                # If nothing is in flight, resume just past the last polled offset.
                commits[p] = offsets[0] if offsets else last + 1
        for p, off in commits.items():
            consumer.commit({p: off})

threading.Thread(target=committer, daemon=True).start()

for record in consumer:
    with inflight_lock:
        inflight[record.partition].add(record.offset)
        last_seen[record.partition] = record.offset
    sub_key = record.value["subsystem"]
    idx = hash(sub_key) % NUM_WORKERS
    queues[idx].put(record)
```

A note on `SortedList`: it keeps the in-flight offsets sorted so `offsets[0]` is the smallest still running. A standard-library min-heap (`heapq`) works too, but heaps cannot cheaply remove a finished offset from the middle; the usual workaround is "lazy deletion", marking an offset done in a separate set and skipping already-done entries when you pop. `SortedList` avoids that bookkeeping.

Committing the smallest in-flight offset, not the highest finished one, is what gives you at-least-once. When nothing is in flight it commits `last + 1`, so a fully-drained partition does not get re-read from the start. The sorted set is per-partition because Kafka commits are. The lock is coarse, fine for hundreds of thousands of records per second; past that, shard the tracking.

The consumer knobs that matter for this pattern, with defaults from the Java client ([consumer configs reference](https://docs.confluent.io/platform/current/installation/configuration/consumer-configs.html)). The last two interact: `max.poll.records` bounds how many records you take per poll, and `max.poll.interval.ms` bounds how long you may hold them before the broker assumes you died.

| Setting | Default | Why you change it |
|---|---|---|
| `enable.auto.commit` | `true` | Set to `false`; auto-commit will race the watermark and ack records the workers have not finished. |
| `max.poll.records` | `500` | Cap the per-poll batch so the in-flight set stays bounded and one slow worker cannot pin offsets for minutes. Smaller batches also finish more easily within `max.poll.interval.ms`. |
| `max.poll.interval.ms` | `300000` | The hard ceiling on how long workers can hold a batch before the broker rebalances you out of the group. A rebalance is Kafka reassigning partitions among the consumers in a group; if you hold a batch too long the broker assumes you died and hands your partitions to someone else. Set this with the worst-case `process()` latency in mind, not the median. |

## A tiny simulation

A throughput simulation: one run with hostname keying where one host is 50x noisier, one with `host#bucket` salting on that host. (It uses Python's `hash()` rather than murmur2; any uniform hash shows skew.)

```python
import collections, random, statistics

NUM_PARTITIONS = 24
NUM_HOSTS = 4000
NOISY_HOST = "host-prod-a-1471"
NOISY_FACTOR = 50
SALT_BUCKETS = 16

# Probability tuned so the noisy host emits ~50x a normal host's share.
# Each normal host's share is 1/NUM_HOSTS of the non-noisy traffic.
# Solving NOISY_PROB / ((1 - NOISY_PROB) / NUM_HOSTS) = 50 gives ~1.2%.
NOISY_PROB = NOISY_FACTOR / (NUM_HOSTS + NOISY_FACTOR)

def simulate(keyer, n_events=2_000_000):
    counts = collections.Counter()
    for _ in range(n_events):
        if random.random() < NOISY_PROB:
            host = NOISY_HOST
        else:
            host = f"host-prod-a-{random.randint(0, NUM_HOSTS - 1)}"
        partition = hash(keyer(host)) % NUM_PARTITIONS
        counts[partition] += 1
    return counts

plain = simulate(lambda h: h)
salted = simulate(
    lambda h: f"{h}#{random.randint(0, SALT_BUCKETS - 1)}"
              if h == NOISY_HOST else h
)

def report(label, c):
    vals = [c[p] for p in range(NUM_PARTITIONS)]
    print(f"{label}: max={max(vals):>8}  p50={int(statistics.median(vals)):>7}  "
          f"ratio={max(vals)/statistics.median(vals):.1f}x")

report("plain ", plain)
report("salted", salted)
```

On my laptop the plain run at `NOISY_FACTOR=50` gives about `max=110,000 p50=82,000 ratio=1.3x`. Here `p50` is the median, the 50th percentile: half the partitions stay under that value. Set `NOISY_FACTOR=1` and the same code produces `ratio=1.08x`, a 24-partition uniform distribution, so 1.3x is already mild skew. Push `NOISY_FACTOR` higher and the ratio climbs roughly linearly with the noisy host's share, while the salted run flattens the worst case back to a small multiple of the median.

The salted run also moves the median *up*, a second-order effect that matters as much as flattening the peak. An unbalanced topic pins one partition at its drain limit while the other 23 sit half-idle, hardware you pay for and do not use.

## Broker-side runbook

A runbook is a written set of steps you follow during an incident. This one is for the person with broker shell access at 02:00. Commands assume Kafka.

- `kafka-consumer-groups.sh --bootstrap-server $B --group $G --describe`: confirm the lag is on one or two partition columns, not spread evenly. If even, your problem is downstream.
- `kafka-run-class.sh kafka.tools.GetOffsetShell --topic $T --time -1` against the live offsets minute over minute gives per-partition produce rate without leaving the broker host. Useful when your metrics pipeline is itself down.
- A 30-second consumer dump from the hot partition with `kafka-console-consumer.sh --partition $P --property print.key=true`, piped through `awk '{print $1}' | sort | uniq -c | sort -rn | head`. Top key over 30% means a hot key, not a hot partition.
- Resist the urge to write a reassignment JSON and run `kafka-reassign-partitions.sh` to fix *this*. The tool reassigns partition replicas across brokers. A replica is a copy of a partition kept on another broker for durability; reassignment moves which brokers hold those copies. It does not touch the producer-side `murmur2(key) % N` mapping covered above ([Strimzi reassignment overview](https://strimzi.io/blog/2022/09/16/reassign-partitions/)), so it cannot rebalance load *inside* a single hot partition; that needs more partitions, a different key, or a custom partitioner. Worse, the catch-up replication during a move reads from the source broker that is already overloaded. It is the right tool for "this broker is overloaded across many partitions," only once the spike has passed.
- If the spike will persist, push the salting fallback for the offending keys at the producer, not the broker. The broker routes by whatever key you send; it does not look at what your keys mean.
- Once the spike is gone, archive the per-partition rate graph and the top-key dump into the incident doc.

Hostname keying itself is fine. The hidden assumption that traffic is evenly spread across hosts is what bites you, and it is rarely written down. Measure your distribution, and decide your fallback before the page fires.
