# Hot-shard pitfalls when you key by hostname

*a short tour through the day your evenly-sharded topic stops being evenly sharded*

Last Tuesday at 14:07, `host-prod-a-1471` started emitting 20 times its usual event volume. Nothing else changed: same topic, same producer code, same consumer group. By 14:09 one partition out of 24 was carrying 70% of the bytes, and the per-host state machine draining that partition fell three minutes behind and kept falling. Every team eventually ships a pipeline keyed by `hostname` and hits the same skew problem on a quiet Tuesday.

How you spot the hot partition, why the first three things you will try make it worse, and what actually fixes it.

## Why hostname-keying is so seductive

The promise of partition-by-key is per-key ordering. If every event from `host-prod-a-1471` lands in the same partition, you process them in order with a single consumer thread: per-host state machines, sequence-number dedup, incremental aggregation without cross-consumer coordination. Clean. Cheap. The producer code is one line:

```python
producer.send(
    topic="host-events",
    key=event["hostname"].encode(),
    value=json.dumps(event).encode(),
)
```

Kafka's `DefaultPartitioner` hashes the key with murmur2 and takes it mod the partition count: literally `toPositive(Utils.murmur2(keyBytes)) % numPartitions` (see the [DefaultPartitioner source](https://github.com/apache/kafka/blob/3.2.0/clients/src/main/java/org/apache/kafka/clients/producer/internals/DefaultPartitioner.java); librdkafka uses the same scheme for `partitioner=murmur2_random`). The event lands in a deterministic partition, and because a Kafka partition is consumed by exactly one consumer within a group, you get a clean single-threaded drain per key. Here is the flow:

```
event.hostname  ->  murmur2(keyBytes)  ->  hash % 24  ->  partition N  ->  one consumer thread
   "host-1471"        0x9F3A12C7              7              P7              consumer-c
```

As long as your hostnames are roughly uniformly distributed across the fleet, your partitions stay roughly balanced. The keyword is "as long as."

## The day uniformity dies

You have 24 partitions and 4,000 hosts. Each partition gets traffic from ~165 hosts, and even if some are chattier than others, the average smooths out. P99 partition throughput sits maybe 1.4x the median, and nothing pages.

Now consider three plausible scenarios that break this:

1. **A regression storm.** Someone merges a firmware change. On any host where that firmware loads, a driver fault loop kicks in and the host emits 5,000 errors per second instead of the normal 5. Suddenly twenty hosts are 1,000x noisier than the rest. Those twenty hosts are spread across maybe twelve partitions, but the four unlucky partitions that got multiple noisy hosts are now carrying 80% of the topic's bytes.

2. **A long-running batch job.** A pricing team kicks off a 48-hour reindex on a beefy box called `svc-pricing-12`. The job emits an audit event per row processed, the partition holding `svc-pricing-12` is suddenly carrying one host worth of data at a rate higher than the other 23 partitions combined.

3. **Naming convention drift.** Half your hostnames now collapse into a low-cardinality prefix because someone deployed a fleet of identical short-lived workers all named `worker-pool-a`. The hash of that single key wins the partition lottery for one partition, and that partition now serves the entire worker pool.

In every one of these, the partition count is fine, the hash is fine, the consumer hardware is fine. The data distribution is what broke.

## Spotting the hot partition

The first sign is almost never "partition X is hot." It is "consumer lag is rising on consumer group Y." Someone then looks at per-partition lag and notices it is concentrated. Your dashboard has to have per-partition lag, not just aggregate. If you only watch aggregate, you mistake a hot-shard problem for a "consumer too slow" problem, which leads to the second mistake: scaling up the consumer.

Useful broker-side metrics, in rough order of usefulness:

- Per-partition produce rate. Worth flagging: the stock JMX MBean `kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec,topic=X` is per-topic, not per-partition, and there is no built-in per-partition variant. To get per-partition `BytesIn` you either compute log-dir size deltas (`kafka.log:type=Log,name=Size,topic=X,partition=Y` sampled over time) or run a custom collector that diffs per-partition end offsets. Most teams hunt for an MBean that does not exist; save yourself the search.
- `MessagesInPerSec` per topic, paired with per-partition end-offset deltas to separate "one giant event" from "a flood of small events."
- Per-partition consumer lag (records, not bytes), via `kafka-consumer-groups.sh --describe` or `kafka.consumer:type=consumer-fetch-manager-metrics,name=records-lag,...`. What actually wakes you up.
- Producer-side key distribution. If you can sample produced keys for a minute and build a histogram, you instantly know whether one key is dominating.

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

If the top key is doing 60% of the partition's volume, you have a hot key, not a hot partition. Those are different problems and they need different fixes.

## The three things you will try first, and why they all make it worse

When the page fires, the instinct is to redistribute. Three common moves either do nothing or make it worse:

**Add partitions.** Kafka lets you increase partition count on a topic, and this is worse than it sounds. When you go from 24 partitions to 48, the hash-mod changes for every key. For keyed messages using hash-mod partitioning (the default), Confluent is explicit that increasing partitions does not redistribute existing data and that new writes with the same key may land on a different partition, breaking per-key affinity at the alter boundary ([Kafka partition determination docs](https://docs.confluent.io/kafka/operations-tools/partition-determination.html)). Concretely:

```
key K = "host-prod-a-1471"
murmur2(K) = 0x9F3A12C7

before alter (24 partitions):   hash(K) % 24 = 5     -> all history on P5
after  alter (48 partitions):   hash(K) % 48 = 19    -> new writes on P19

P5  [...older offsets, now stranded for ordering purposes...]
P19 [new offsets, no idea P5 exists]
```

Old messages stay on partition 5, new messages from that same key land on 19, and you have lost per-key ordering at the boundary for every key in the topic. Meanwhile your hot key just picked a new partition to melt. You have broken ordering globally and fixed nothing locally.

Even a full repartition (new topic, mirror data over) only helps if your hot keys are spread across the new space. If the noise is one host, that one host is still going to a single partition. Doubled broker overhead, same problem.

**Add consumers.** A single Kafka partition is consumed by exactly one consumer in a group. You can have 200 consumers in the group and the hot partition is still being drained by one of them. Adding consumers just means 199 of them are idle while one melts.

**Switch to round-robin keying.** This actually does flatten the partitions. It also destroys per-host ordering, which was the entire reason you chose hostname-keying. If your consumer assumes ordered per-host events (and it almost certainly does, even if nobody wrote that down), you have introduced a bug class that will not surface until a customer complains about a reordered state transition three weeks from now.

So the trap is real. The naive fixes do nothing, do harm, or trade one problem for a worse one.

## What actually works

Three patterns help, in roughly increasing order of complexity:

### 1. Composite keys

If `hostname` alone is too coarse, key by `(hostname, secondary_dimension)` where the secondary dimension is something that splits the chatty host's traffic without breaking the ordering you actually need.

The classic example: error events from a single host often cluster around a specific subsystem. If `svc-pricing-12` is emitting 5,000 events per second but they are spread across 20 subsystems, then `(hostname, subsystem)` keys give you 20 distinct keys instead of 1. Hash collisions will collapse some of those onto the same partition, but you are no longer guaranteed to pin all 5,000 events to a single shard.

```python
key = f"{event['hostname']}|{event['subsystem']}".encode()
producer.send(topic="host-events", key=key, value=...)
```

The catch: you have just changed your ordering guarantee. You now have per-(host, subsystem) ordering, not per-host ordering. Read your consumer carefully. If it does cross-subsystem state transitions per host, this breaks it. If it does not, you are fine.

A concrete failure mode worth naming: a consumer that maintains a `last_seen[host]` state across subsystems. Before composite keying, every event for `host-prod-a-1471` arrived on the same partition in produce order, so the consumer could write `last_seen["host-prod-a-1471"] = max(current, event.ts)` and trust it. After composite keying, `(host, subsystemA)` lands on P3 and `(host, subsystemB)` lands on P11, drained by two different consumer threads. Now an event from subsystemA at t=100 and one from subsystemB at t=99 arrive in either order. Your `last_seen` writes interleave, and any logic that fires on a transition (alerting when a host goes silent, deduping based on previous-state) gets non-deterministic answers. The bug class is "cross-key invariants on what used to be a single-key stream." It will not show up in tests, only in incident postmortems six weeks out.

### 2. Salt-then-bucket

When you genuinely need per-host ordering most of the time but want a safety valve for the pathological cases, salt the key with a small bounded fan-out.

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

This static version trades ordering for spread inside the bucket count and scatters every event from a hot host onto a random partition; use it only when downstream consumers can tolerate completely random scatter across `SALT_BUCKETS`. `HOT_HOSTS` is a small set, refreshed periodically from your metrics. Maybe it lives in a config map, maybe it is computed by a side process that watches per-partition rates and pushes the top offenders. The point is: 99% of your traffic gets clean per-host ordering, and the 1% of pathological hosts get fan-out, with the understanding that those hosts have temporarily lost their ordering guarantee.

The consumer side has to know about this. Events from a salted host arrive on multiple partitions, so any per-host aggregation needs a reconciliation step. Often that is acceptable: the alternative is dropping events or melting one consumer.

A variant I have seen work well: instead of a static `HOT_HOSTS` list, every event gets `host#bucket(host, time_window)` where the bucket is `0` for normal hosts and a hashed spread for hosts that have crossed a rate threshold in the last minute. Self-healing, no config push needed, and it falls back to single-bucket as soon as the spike subsides:

```python
def bucket(host, now):
    window = now // 60  # 60-second rolling window
    rate = rate_counter.get(host, window)  # events/sec from a sliding-window counter
    if rate < HOT_THRESHOLD:
        return f"{host}#0"
    return f"{host}#{hash((host, window)) % SALT_BUCKETS}"
```

The `time_window` is what makes it self-healing: a host that goes hot at 14:07 spreads across `SALT_BUCKETS` for the duration of that minute, then if the spike subsides by 14:08 it collapses back to bucket 0 with no operator action. Consumers that need cross-bucket aggregation reconcile on the host key, not the salted key.

### 3. Single partition, multiple consumer threads

Sometimes you cannot change the keying: downstream contracts, the consumer-owning team is on vacation, or the topic is shared with three other services on the current scheme. You can still parallelize the drain.

The trick is to keep one Kafka consumer reading the hot partition, but hand records off to a thread pool keyed by a sub-dimension you control. As long as you keep the per-sub-key ordering, you can recover throughput without changing the topic at all.

The offset-commit dance is the tricky part. If you commit naively after enqueueing, a crash mid-processing loses records. If you commit after each worker finishes, you can commit out of order and lose at-least-once semantics. The fix is a watermark commit: keep a sorted set of in-flight offsets per partition, and on a tick, commit the smallest offset that is fully drained. Here is the whole thing:

```python
import collections, threading, time
from queue import Queue
from sortedcontainers import SortedList  # pip install sortedcontainers; or use heapq with lazy deletion from the stdlib

NUM_WORKERS = 16
queues = [Queue(maxsize=10_000) for _ in range(NUM_WORKERS)]

# Per-partition set of offsets still being processed.
inflight = collections.defaultdict(SortedList)
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
            for p, offsets in inflight.items():
                # Safe commit point: lowest in-flight offset minus one.
                # If nothing is in flight, commit the last seen offset.
                if offsets:
                    commits[p] = offsets[0]
        for p, off in commits.items():
            consumer.commit({p: off})

threading.Thread(target=committer, daemon=True).start()

for record in consumer:
    with inflight_lock:
        inflight[record.partition].add(record.offset)
    sub_key = record.value["subsystem"]
    idx = hash(sub_key) % NUM_WORKERS
    queues[idx].put(record)
```

A couple of things to notice. The committer commits the smallest in-flight offset, not the largest completed one, which is what gives you at-least-once: on crash, you replay everything from the watermark forward, including some records that finished. Your `process()` has to be idempotent. The sorted set is per-partition because Kafka commits are per-partition. And the lock is coarse, fine for hundreds of thousands of records per second; if you push past that, shard the in-flight tracking per partition.

The consumer knobs that actually matter for this pattern, with their defaults from the Java client ([consumer configs reference](https://docs.confluent.io/platform/current/installation/configuration/consumer-configs.html)):

| Setting | Default | Why you change it |
|---|---|---|
| `enable.auto.commit` | `true` | Set to `false`; auto-commit will race the watermark and ack records the workers have not finished. |
| `auto.commit.interval.ms` | `5000` | Irrelevant once auto-commit is off, but worth knowing the silent 5s tick exists. |
| `max.poll.records` | `500` | Cap the per-poll batch so the in-flight set stays bounded and one slow worker cannot pin offsets for minutes. |
| `max.poll.interval.ms` | `300000` | The hard ceiling on how long workers can hold a batch before the broker rebalances you out of the group. Set this with the worst-case `process()` latency in mind, not the median. |


## A tiny simulation

To make this concrete, here is a 30-line throughput simulation. One run with hostname keying where one host is 50x noisier, one run with `host#bucket` salting on the noisy host.

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

On my laptop the plain run at `NOISY_FACTOR=50` gives roughly `max=110,000 p50=82,000 ratio=1.3x`. That 1.3x is not the true baseline; it is baseline-with-mild-skew, and the noisy host is already dominating the worst partition even at 50x. Set `NOISY_FACTOR=1` and the same code produces something close to `ratio=1.08x`, which is what 24-partition uniform distribution actually looks like. Push `NOISY_FACTOR` higher and the ratio climbs roughly linearly with the noisy host's share of traffic; the salted run flattens the worst case back to a small multiple of the median even at the higher factor. The salted run also moves the median *up*, because the noisy host's traffic is now contributing to many partitions instead of starving one. That second-order effect is easy to miss but it is the whole reason this works: a balanced topic does more aggregate work than an unbalanced one with the same hardware.

ASCII version of the same idea, before and after, partition fill:

```
plain:                              salted:
P0   ##                             P0   ####
P1   ##                             P1   ####
...                                 ...
P11  ################ <- hot key    P11  #####
...                                 ...
P23  ##                             P23  ####
```

## What to keep in the broker-ops drawer

This runbook is for the person with broker shell access at 02:00, not the consumer team. The commands assume Kafka, adapt for your flavor.

- `kafka-consumer-groups.sh --bootstrap-server $B --group $G --describe`: confirm the lag is on one or two partition columns, not spread evenly. If it is even, your problem is downstream, stop reading this post.
- `kafka-run-class.sh kafka.tools.GetOffsetShell --topic $T --time -1` against the live offsets minute over minute gives you per-partition produce rate without leaving the broker host. Useful when your metrics pipeline is the thing that is on fire.
- A 30-second consumer dump from the hot partition with `kafka-console-consumer.sh --partition $P --property print.key=true`, piped through `awk '{print $1}' | sort | uniq -c | sort -rn | head`. If the top key owns more than 30% of the dump, you have a hot key, not a hot partition.
- Resist the urge to write a reassignment JSON and run `kafka-reassign-partitions.sh` while the spike is live. The tool relocates replica log directories across brokers but does not change the producer-side `murmur2(key) % N` mapping ([Strimzi reassignment overview](https://strimzi.io/blog/2022/09/16/reassign-partitions/)), and the replication traffic will make the hot broker hotter. Reassignment is for "this broker is overloaded across many partitions," not "this partition is hot."
- If the spike is going to persist past your patience, push the salting fallback for the offending keys at the producer, not the broker. Brokers have no opinions about your keys.
- Once the spike is gone, archive the per-partition rate graph and the top-key dump into the incident doc. The next hot partition will look exactly like this one, and you will not remember the threshold you used.

Hostname keying is not the problem. The implicit assumption of uniform traffic is. Measure your distribution, decide your fallback before the page fires.
