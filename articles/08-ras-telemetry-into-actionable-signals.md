# Turning RAS telemetry into actionable signals

*coalesce, correlate, then alert: turning the kernel firehose into a pager queue you can defend*

A single RAS event from `rasdaemon` looks roughly like this:

```
mce: [Hardware Error]: Machine check events logged
EDAC MC0: 1 CE memory read error on CPU_SrcID#0_MC#0_Chan#2_DIMM#1
  (channel:2 slot:1 page:0x3a124 offset:0x140 grain:32 syndrome:0x0)
```

Multiply that by a few hundred classes (memory controllers reporting corrected errors, PCIe links logging recoverable AERs, CPUs emitting MCEs for cache parity hiccups, GPUs surfacing XID events for everything from a tired fan to a dying HBM stack) and a few thousand nodes, and you have a firehose. The kernel dutifully forwards all of it to userspace via `/dev/mcelog`, `rasdaemon`, `edac`, `dmesg`, or whatever vendor-specific socket happens to be fashionable this quarter.

Pipe that raw firehose into PagerDuty across a few thousand nodes and the on-call rotation will revolt inside a week. A naive RAS exporter at that scale can easily generate tens of thousands of alerts in the first hour. Reasonable response.

This post is about the layer between the firehose and the pager. The part where you turn "node-1471 emitted 14 corrected ECC events in the last 30 seconds" into either silence, a dashboard tick, a ticket, or "go physically replace this DIMM before the rack catches a real fault." Get this layer right and the fleet stays runnable; get it wrong and the pager owns you.

One acid test threads the whole post: pick any page from last week, ask the on-call whether the outcome would have been identical had you silenced it, count how often the honest answer is yes. Everything below pushes that number down.

## What RAS events actually look like

Strip away the vendor packaging and almost every RAS event has the same shape:

```
timestamp     : 2026-06-03T11:42:17.331Z
node_id       : compute-1471
component     : DIMM_A2
severity      : corrected | uncorrected | fatal
class         : memory | cache | pcie | thermal | power | accelerator
event_code    : MEM_ECC_CORR
location      : socket=0 channel=2 dimm=1 rank=0 row=0x3A12 col=0x14
count         : 1
raw           : { ...whatever blob the vendor dumped... }
```

That's it. Everything you care about derives from those eight fields plus the right amount of memory about what came before.

Two fields mislead first-time builders. Severity and count both look authoritative; both lie. A "corrected" event can be a perfectly healthy DIMM doing exactly what ECC was designed to do, or it can be a DIMM about to fail catastrophically. A `count=1` event can repeat 9,000 times in a minute. You cannot treat individual events as alertable units. You have to treat them as samples from an underlying process.

## The pipeline shape

Here's the layout that I keep ending up at after building this thing four times. Names are made up.

```
   nodes (10k+)
       |
       v
+------------------+     +------------------+     +------------------+
|  node-collector  | --> |    ras-broker    | --> |    coalescer     |
|    (per-host)    |     | (NATS jetstream  |     |  (sliding wins)  |
|                  |     |     or Kafka)    |     |                  |
+------------------+     +------------------+     +------------------+
                                                           |
                                                           v
                                                  +------------------+
                                                  |    correlator    |
                                                  |   (cross-comp)   |
                                                  +------------------+
                                                           |
                                                           v
                                       +-----------------------------+
                                       |  policy engine + thresholds |
                                       +-----------------------------+
                                          |          |          |
                                          v          v          v
                                      dashboard   ticket      pager
```

The collector is dumb on purpose. It tails the kernel sources, normalizes into the canonical event above, attaches a fleet-wide monotonic sequence number, and pushes. No filtering, no thinking. If the collector starts being clever it will mask real failures, and you will find out about them from a customer.

Everything interesting happens downstream of the broker, where you have the full history available and you're not running on a node whose memory you're trying to diagnose.

## Step one: deduplicate the obvious noise

A lot of RAS sources will fire the same event multiple times for the same physical incident. The kernel decodes an MCE bank, the dynamic poller speeds up after a hit (the interval halves on each error with a floor of `HZ/100`, so on the order of tens of milliseconds and kernel-config dependent; see `arch/x86/kernel/cpu/mce/core.c` and `Documentation/x86/x86_64/machinecheck`), decodes the same bank again, emits another event. Some BMCs will mirror the same SEL entry through both IPMI and Redfish.

First pass is exact dedup on `(node_id, component, event_code, location, timestamp_truncated_to_100ms)`. A TTL-cached hash set with a 30-second window handles this for cheap. In my experience this drops 20-40% of event volume on a busy fleet without losing information; measure on your own data before quoting a number.

```python
def dedup_key(ev):
    return (ev.node_id, ev.component, ev.event_code,
            ev.location, ev.timestamp // 100)  # 100ms buckets

seen = TTLSet(window=30)  # exact membership, no false positives
for ev in stream:
    if dedup_key(ev) in seen:
        metrics.duplicates.inc()
        continue
    seen.add(dedup_key(ev))
    out.publish(ev)
```

Quick aside: do not reach for a bloom filter here unless you have profiled and the hash set is actually too big. The false-positive rate is tunable but never zero, and for dedup a false positive means a real RAS event silently disappears. At a 1e-4 FPR the standard formulas (`m/n = -log2(p)/ln2`, `k = (m/n)*ln2`; see `en.wikipedia.org/wiki/Bloom_filter#Probability_of_false_positives`) give roughly 14 bits per element and around 10 hash functions per insert, so you lose roughly one real event in ten thousand. Most production implementations cap `k` at 7-10, which inflates FPR above the theoretical figure, so measure rather than assume. Smaller filter, worse rate. If memory pressure forces it, pick an FPR explicitly, put it on the dashboard, and emit a "dropped-as-duplicate" counter so somebody can sanity-check the loss.

This is the cheapest 30% you'll ever get.

## Step two: coalesce into incident objects

Now the interesting part. Raw events are the wrong unit. The unit you want is an **incident**: "DIMM A2 on node-1471 had a burst of N corrected errors over T seconds." You make incidents by coalescing events using a sliding window keyed on the physical thing that's failing.

The natural coalescing key for memory is `(node_id, socket, channel, dimm)`. Not `(node_id, address)`, because address-level coalescing makes you blind to a degrading DIMM that's flipping bits in many different rows. You want the DIMM as the bucket, even if you log the address-level breakdown inside the incident.

For PCIe it's `(node_id, segment, bus, device)`. For CPU cache it's `(node_id, socket, core, cache_level)`. The right key is "the thing you would physically replace."

A sliding window implementation that's been reliable for me:

```python
class IncidentWindow:
    def __init__(self, window_sec=300, flush_idle_sec=60):
        self.window = window_sec
        self.flush_idle = flush_idle_sec
        self.incidents = {}  # key -> Incident

    def feed(self, ev):
        key = coalesce_key(ev)
        inc = self.incidents.get(key)
        now = ev.timestamp
        if inc is None or now - inc.last_seen > self.flush_idle:
            if inc is not None:
                yield inc.finalize()
            inc = Incident(key, started=now)
            self.incidents[key] = inc
        inc.add(ev)
        # also flush any incident older than window
        for k, i in list(self.incidents.items()):
            if now - i.last_seen > self.window:
                yield i.finalize()
                del self.incidents[k]
```

The inner sweep above is fine for a sketch but it is O(open_incidents) per event. During a fleet-wide thermal event with tens of thousands of open incidents that loop becomes the bottleneck of the entire pipeline. Replace it in production with one of: a separate periodic flush task that sweeps every few seconds (the simplest fix), a delay queue keyed by expiry time, or a min-heap with lazy invalidation (push a new entry on every update and skip stale entries on pop, since standard heaps cannot cheaply update an existing key). Per-event cost stays O(1) amortized regardless of how many incidents are open.

Two timeouts matter. `flush_idle_sec` is "how long with no events before we consider the incident closed and ship it." Sixty seconds is a reasonable default for memory. `window_sec` is the hard ceiling: a single incident can't run forever, otherwise a slowly-degrading part would never trigger an alert because the incident object would just keep growing silently.

The incident you ship downstream has a much richer shape:

```
incident_id    : inc-2026-06-03-compute-1471-DIMM_A2-001
key            : node=compute-1471 socket=0 channel=2 dimm=1
started        : 2026-06-03T11:42:17.331Z
ended          : 2026-06-03T11:44:17.812Z
duration_sec   : 120
event_count    : 1500
event_rate     : 12.5 ev/sec
severity_max   : corrected
unique_rows    : 47
unique_cols    : 312
unique_banks   : 8
first_event    : { ... }
last_event     : { ... }
worst_event    : { ... }
```

Notice `unique_rows` and `unique_banks`. These are the difference between "one stuck bit" and "a DIMM losing the will to live." A stuck bit will repeat the same `(row, col, bank)` thousands of times. A degrading DIMM will scatter errors across many rows. Coalescing only by count throws this signal away.

## Step three: correlate across components

Half the time the actual failing component is not the one reporting the error. Common cases that look like one bug and are actually another:

- A failing power supply causes voltage ripple on the memory rails, which causes corrected ECC events on every DIMM on that side of the board. If you alert per-DIMM you'll page on six DIMMs simultaneously when the real fix is one PSU.
- A bad PCIe riser causes correctable AERs on the GPU plugged into it, AND correctable errors on the NVMe plugged into the slot below, AND the BMC will report a thermal anomaly because the GPU is throttling. Three separate alarm sources, one cable.
- A CPU running too hot will throw cache parity MCEs that look exactly like silicon defects until you correlate with the thermal sensor history.

So after the coalescer, you want a correlator that takes incident objects within a time window and groups them by **physical proximity**. The grouping graph is built from your node inventory: which DIMMs share a memory controller, which slots share a riser, which components share a power rail, which sensors share a cooling zone.

```
correlator pseudocode:
  for each new incident I:
    related = []
    for each open incident J in last 120s:
      if proximity_distance(I, J) <= 2:
        related.append(J)
    if related:
      merge_into_supergroup(I, related)
    else:
      open new supergroup(I)
```

`proximity_distance` is a graph distance over your hardware topology. Same DIMM = 0. Same memory controller = 1. Same socket = 2. Same node = 3. You usually want to merge at distance <= 2, but it depends on how aggressive you want your "this might be one thing" guess to be.

Concretely, the topology the correlator walks looks like this for one node:

```
                      node:compute-1471          <-- 3
                     /                 \
                socket:0           socket:1      <-- 2
                /     \             /     \
              MC:0   MC:1         MC:0   MC:1    <-- 1
             /  \    /  \         /  \    /  \
           A0  A1  A2  A3       B0  B1  B2  B3   <-- 0 (DIMMs)
```

Same DIMM: 0. Same MC, different DIMM: 1. Same socket, different MC: 2. Same node, different socket: 3. PSU and cooling-zone edges sit above the node, so PSU-driven events land at 4+. The graph is the inventory you already have for replacements, reused.

When you ship a supergroup downstream, you ship the constituent incidents plus a guessed root cause based on which physical layer they share. The policy engine uses this to decide whether to page once or six times.

## Step four: thresholds that look at rate, not count

Now the alerting policy. The common mistake is `count > N`. The correct thing is almost always a **rate** plus a **dispersion**.

For corrected memory errors, the rule I've landed on (and steal-this-if-you-want). Rules are evaluated in parallel; the highest-severity match wins, not the topmost row:

| Condition | Action |
|---|---|
| incident.event_count < 10 AND incident.unique_rows == 1 | drop (single stuck bit, log to dashboard) |
| incident.event_count < 50 AND incident.duration > 3600s | log to dashboard, no ticket |
| incident.event_rate > 1.0/sec sustained for 60s | ticket, P3 |
| incident.unique_rows > 10 AND incident.event_count > 100 | ticket, P2 (degrading DIMM) |
| incident.event_rate > 10/sec for 30s | page, P1 |
| any uncorrected event | page, P1 |
| supergroup spans > 4 DIMMs on same memory controller | page, P1 (controller or PSU) |

The dispersion check (`unique_rows > 10`) is what catches the slow-burn failures that count-based thresholds miss. A DIMM throwing 200 corrected errors all on the same row is a single bit cell that ECC will handle until the heat death of the universe. A DIMM throwing 200 corrected errors across 47 different rows is going to fail this week. Same count, different physics.

Walking the earlier incident through this table: `inc-2026-06-03-compute-1471-DIMM_A2-001` has `event_rate=12.5/sec` over `120s` and `unique_rows=47`. Row 3 matches (rate > 1.0/sec past 60s, P3). Row 4 also matches (unique_rows=47, event_count=1500, P2). Highest severity wins, so it tickets as a P2 "degrading DIMM" with the row-3 match attached as evidence.

## Rate AND dispersion, not rate alone

RAS bursts have a specific pathology: two incidents can have identical rate and wildly different physics. A DIMM throwing 500 corrected errors in two seconds, all on one row, is one stuck cell ECC will mask forever. The same 500 errors scattered across 50 rows is a part that will fail this week. Rate alone cannot tell those apart, so the windowing strategy has to feed both rate and dispersion into the policy engine.

Two synthetic streams, both 100 events over 60s, both fed into the same 5s sliding windower:

```
stuck-bit:   100 events, all on (row=0x3A12, col=0x14)
scattered:   100 events, across 100 distinct (row,col) pairs

per-5s window output (rate ev/s, unique_locations):
  t=  0..5    stuck=(1.6, 1)   scattered=(1.6, 8)
  t=  5..10   stuck=(1.8, 1)   scattered=(1.8, 9)
  ...
  t= 55..60   stuck=(1.6, 1)   scattered=(1.6, 8)

over the full 60s:
  stuck-bit:   rate ~1.6/s   dispersion = 1
  scattered:   rate ~1.6/s   dispersion = 100
```

Identical rates, two-orders-of-magnitude difference in dispersion. Rate-only policy treats them the same; `(rate, dispersion)` ships the stuck-bit to the dashboard and ticket-queues the scattered one as a degrading DIMM.

That means each window holds two aggregates: events-per-second and unique-physical-locations. Keep multiple window sizes in parallel and emit the worst pair, because a burst of 500 events in 2 seconds inside a 60s window will look like 8.3/sec average and trip nothing:

```
windows = [5s, 15s, 60s, 300s]
for w in windows:
    rate       = events_in_window(w) / w
    dispersion = unique_locations_in_window(w)
    if rate > rate_threshold[w] or dispersion > disp_threshold[w]:
        alert(...)
```

For the rate path specifically, EWMA reacts to bursts faster than a flat average without overreacting to single spikes:

```
ewma = alpha * current_rate + (1 - alpha) * ewma
# at a 5s sample period, alpha = 0.3 gives an effective time constant
# tau = period / alpha = 5 / 0.3 ~= 17s, i.e. ~3 samples of memory
```

`tau = period / alpha` is the only thing worth remembering. Pick the time constant first, then derive alpha from the sample period. Tuning alpha without thinking about the period is how teams end up with smoothing that silently changes behavior whenever someone retunes the scraper.

Flat windows for tickets (the count needs to mean something for a human reading it), EWMA for paging (you want to react fast), dispersion always (it is the only signal that catches the slow-burn DIMM death before it becomes an uncorrected event).

## Backpressure, retries, and what happens when things break

The RAS pipeline itself can fail. The broker can lag. The coalescer can OOM during a fleet-wide thermal event when half your fleet is screaming. The correlator can deadlock on a circular proximity edge in your inventory data.

Collector-to-broker has three honest backpressure choices: drop-oldest (bounded memory, lossy), block-the-producer (the producer is the kernel ring buffer; blocking just shifts the loss), and spill-to-disk (durable until disk fills). Default to spill-to-disk with a bounded in-memory ring on top: events are small, producers are slow on average, and the burst preceding a real failure is exactly what you cannot drop. Cap the spill and export a "bytes currently spilled" metric so you see strain before it breaks.

Broker retries are at-least-once with idempotent consumers; the dedup stage above is the idempotency mechanism, which is why it goes first. Per-stage retry budgets, not global, so a wedged correlator does not block a healthy ticket sink.

The failure mode unique to observability: a silent pipeline looks identical to a healthy fleet. There is no negative signal. If a coalescer falls 10 minutes behind and quietly catches up, the on-call sees no events and concludes nothing is wrong, while a row of nodes might be uncorrectable-error-ing into a thermal event nobody knows about. So the rule here: when the pipeline degrades you **escalate, not silence**, and the escalation rides on a separate channel from the data you are doubting.

Concretely: every stage emits its own health metric to a separate channel, with its own broker, its own retention, and its own pager rule. If the RAS pipeline stops producing health pings, the pager fires from that separate channel, not from any RAS event. This is the smoke alarm for the smoke alarm. Same idea applies recursively, which is why you stop at two layers: at some point you have to trust something.

## What to put on the dashboard vs. what to page on

Final piece: not everything that's worth knowing is worth waking someone up for. The split I use:

**Pager**: anything uncorrected, anything fatal, any incident with event_rate > 10/sec, any supergroup spanning multiple components, any node that goes from "healthy" to "throwing RAS events" in under a minute.

**Tickets**: degrading-component incidents (high dispersion, sustained over hours), single-DIMM warnings that have repeated across reboots, anything where the predicted-fail probability from your ML model (if you have one, which is its own post) crosses 30%.

**Dashboard only**: everything else. Yes, even the single corrected ECC errors. They're not actionable individually but the **rate of them across the fleet** is a leading indicator of bad batches, bad firmware revs, or environmental issues in a specific row of the datacenter. You want them visible, not paged.

The acid test for whether your RAS pipeline is good: pick a random page from last week and ask the on-call "did you do something different because of this page, or would the outcome have been identical if I'd silenced it?" If the answer is "identical" more than 20% of the time, your thresholds are too aggressive and you're training the team to ignore the pager. Tighten the rules. Move borderline cases down to tickets. Trust the dashboard for the long tail.

RAS data is valuable in aggregate; the on-call only needs the 1% of events that change behaviour. Build the pipeline that separates the two.
