# Adaptive concurrency limits with gradient and Little's law

*why your 200-thread pool is a hardcoded apology for not measuring anything*

A fixed concurrency limit is a number someone picked on a Tuesday afternoon based on a load test that hasn't been rerun since the last major version of the downstream service. It worked then. It probably still works on a calm day. The interesting question is what it does on a Wednesday when the downstream payment service is in the middle of a slow GC pause and your p99 is climbing toward the dashboard threshold that wakes someone up.

The honest answer is that any static number is wrong almost all the time, just by varying amounts. The useful question is whether you can pick a number that floats with conditions without making the system itself unstable. Two families of algorithms are worth knowing: gradient-based limiters that infer congestion from the second derivative of latency, and Little's-law limiters that calculate the optimal in-flight count from observed throughput and service time. They look similar from the outside. They behave quite differently when the floor falls out.

## The fixed-pool failure mode

Imagine a service called `checkout-svc` calling a downstream payment provider, `payclient`, through a fixed semaphore of 200 permits. On a normal day, payclient is fast and `checkout-svc` runs well below the ceiling. Most of the permits sit idle. Nobody notices, because everything is fine.

Now payclient has a noisy neighbor on its shared infrastructure. Latency drifts upward. Your in-flight count climbs because requests are arriving at the same rate but each one holds a permit longer. Eventually you hit 200 in-flight, the semaphore starts blocking, and the latency you observe (which now includes queue wait time) climbs steeply. The pager fires.

The 200-permit limit is doing exactly what it was designed to do, which is the problem. It does not know that the downstream service has changed its service time. It cannot tell the difference between "we have capacity to spare" and "we are about to make everything worse by piling on more concurrent requests."

```
fixed pool, downstream latency step:

latency (ms)        |                    ___________
                    |                   /
                    |                  /
                    |                 /
                    |                /
                    |    __________/
                    |___/
                    +-------------------- time
                       t0: latency step  t1: queue saturates
                       (downstream slows) (in-flight hits the
                                          pool ceiling, observed
                                          p99 climbs)
```

## Little's law, briefly

Little's law says that for any stable queueing system, the average number of items in the system equals the average arrival rate times the average time each item spends there. Written as `L = λW`. It does not depend on the distribution of anything. It is true in the way that conservation of mass is true.

For a concurrency limiter this is the entire game. If you observe throughput (`λ`, requests per second completing) and you observe service time (`W`, time per request), then the number of concurrent requests the system is sustaining is `L = λW`. If you set your limit at or near that number, you are matching the offered load. If you set it much higher, you are inviting queueing inside the downstream. If you set it much lower, you are leaving throughput on the table.

The version of this that actually shows up in code adds variance terms (Kingman's G/G/1 approximation does this for general arrivals and service times) and tells you how queueing time blows up as you approach saturation. The practical takeaway: for the simplest M/M/1 case the mean wait scales as `1 / (1 - ρ)`, so at ρ=0.8 you are already paying roughly 4x the service time in queue wait, and the curve keeps getting worse. Keep utilization in the 70-80% range depending on how tail-sensitive your service is; the last 20% of capacity costs you more in p99 than the first 80% did.

## Gradient limiters: watch the derivative

The Netflix `concurrency-limits` library popularized a different approach. Rather than computing `L = λW` directly, gradient limiters compare a short-term moving average of latency against a long-term one. If the short term is significantly higher than the long term, you are running into queueing, so you back off. If it is lower or equal, you increase the limit.

A simplified Gradient-style limiter looks roughly like this (the exponential smoothing on the short-term RTT and the `4 * sqrt(limit)` queue allowance are teaching choices, not the Netflix Gradient2 defaults; see the discussion after the code):

```python
class GradientLimiter:
    def __init__(self, initial_limit=10, max_limit=200, smoothing=0.2):
        self.limit = initial_limit
        self.max_limit = max_limit
        self.smoothing = smoothing
        self.long_rtt = None   # exponentially smoothed baseline
        self.short_rtt = None  # recent sample window

    def update(self, sample_rtt_ms, in_flight):
        # initialize on first sample
        if self.long_rtt is None:
            self.long_rtt = sample_rtt_ms
            self.short_rtt = sample_rtt_ms
            return self.limit

        # don't learn from idle-period samples: they bias the long-term
        # baseline downward and make the limiter over-eager to shrink
        # the next time real load returns. Skip both the RTT updates
        # and the limit adjustment when we're nowhere near the limit.
        if in_flight * 2 < self.limit:
            return self.limit

        # long-term tracks slowly, recovers from transient spikes
        self.long_rtt = (1 - 0.01) * self.long_rtt + 0.01 * sample_rtt_ms
        # short-term tracks quickly, reflects current conditions
        self.short_rtt = (1 - self.smoothing) * self.short_rtt \
                         + self.smoothing * sample_rtt_ms

        # gradient: <1 means we're slower than baseline (congested)
        gradient = max(0.5, min(1.0, self.long_rtt / self.short_rtt))

        # adjustment: grow by a Gradient-style queue allowance when
        # healthy, shrink proportionally when congested. The original
        # Gradient algorithm scaled this as 4*sqrt(limit); Gradient2
        # defaults to a flat constant (4) that you can override with
        # a function of the current limit.
        queue_size = int(4 * (self.limit ** 0.5))
        new_limit = gradient * self.limit + queue_size

        self.limit = max(1, min(self.max_limit, int(new_limit)))
        return self.limit
```

A note on what Gradient2 actually does in the Netflix library: it compares the most recent RTT sample directly against a long-term exponentially-weighted baseline (default window ~600 samples) and applies a smoothing factor (default 0.2) to the **limit update itself**, not to the RTT (sources: [Gradient2Limit.java](https://github.com/Netflix/concurrency-limits/blob/main/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/Gradient2Limit.java), [PR #88](https://github.com/Netflix/concurrency-limits/pull/88)). The dials that matter in production are the long-window length, the `queueSize` function, and the limit-update smoothing.

The teaching version above smooths the short-term RTT (0.2) and the long-term RTT (0.01) instead, so the gradient ratio reflects two windows over the same RTT stream. That makes the algorithm easier to reason about on paper, but it is not the library default; treat the specific 0.2 / 0.01 numbers as illustrative of the pseudocode shown, not as production defaults.

Whichever smoothing scheme you use, the dial behaves the same way directionally. Set it too high and you react to single-sample noise; set it too low and you miss real degradations. If your traffic is very low, scale the smoothing up (or require a minimum sample count) so you are not basing decisions on three samples.

## Little's law in practice: VegasLimit and the BDP analogy

The other family takes Little's law literally. TCP Vegas does this for network congestion: it estimates the bandwidth-delay product (BDP) from observed RTT and throughput, and it tries to keep the number of in-flight bytes close to BDP. Below BDP and you are underutilizing. Above BDP and you are filling someone's buffer, which inflates RTT without adding throughput.

A Little's-law concurrency limiter does the same thing for requests. It observes the no-load RTT (the minimum service time it has ever seen) and the current RTT, then computes how many extra requests are queued:

```python
class VegasLimiter:
    # Note: constant alpha=3, beta=6 keeps the example readable.
    # Netflix's VegasLimit actually scales both as functions of the
    # current limit: alpha = 3 * log10(limit) and beta = 6 * log10(limit)
    # (https://github.com/Netflix/concurrency-limits/blob/main/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/VegasLimit.java).
    # The original Brakmo/Peterson TCP Vegas paper used alpha=1, beta=3
    # extra in-flight segments (https://en.wikipedia.org/wiki/TCP_Vegas).
    def __init__(self, initial_limit=10, alpha=3, beta=6):
        self.limit = initial_limit
        self.alpha = alpha  # underflow threshold
        self.beta = beta    # overflow threshold
        self.rtt_noload = float('inf')

    def update(self, sample_rtt_ms, in_flight):
        # track the best (lowest) RTT we've ever observed
        self.rtt_noload = min(self.rtt_noload, sample_rtt_ms)

        # how many in-flight requests are "extra" beyond
        # what the no-load latency would account for?
        # = in_flight - in_flight * (rtt_noload / sample_rtt);
        # the second term is the BDP (Little's-law in-flight count)
        # at the current observed throughput.
        queue_size = in_flight * (1 - self.rtt_noload / sample_rtt_ms)

        if queue_size < self.alpha:
            # underutilized: grow
            self.limit += 1
        elif queue_size > self.beta:
            # queueing detected: shrink
            self.limit -= 1
        # else: hold steady

        self.limit = max(1, self.limit)
        return self.limit
```

The `alpha` and `beta` thresholds define a dead zone. Inside it, you do not change the limit, which prevents oscillation. Outside it, you take a small step. The tradeoff with the gradient limiter is that VegasLimit reacts to the absolute queue size rather than the rate of change, so it is more stable but slower to respond to step changes.

## Comparison

| Property | Fixed pool | Gradient (Gradient2) | Little's law (Vegas) |
|---|---|---|---|
| Reacts to latency steps | No | Yes, within smoothing window | Yes, but slower |
| Oscillation risk | None | Medium (smoothing-dependent) | Low (dead zone) |
| Needs no-load RTT estimate | No | No | Yes (uses observed min) |
| Tuning surface | One number | Smoothing + queue size formula | Alpha, beta thresholds |
| Behavior on cold start | Whatever you set | Grows from initial limit | Grows from initial limit |
| Behavior under sustained overload | Saturates, queues internally | Contracts | Contracts |
| What it optimizes for | Nothing; it is a guess | Keeping latency near baseline | Keeping queue depth bounded |

In production both work. The gradient version is more aggressive and tends to find a higher steady-state limit, which gives you more throughput on a good day. The Vegas version is more conservative and tends to hold a tighter limit, which gives you better p99 on a bad day. Pick based on which day you fear more.

## The payment-client incident (illustrative)

Back to the `checkout-svc` / `payclient` sketch. Imagine replacing the fixed 200-permit pool with a Gradient2 limiter, keyed per downstream endpoint so a degradation in `payclient.charges` does not cause `payclient.refunds` to shrink.

The first thing you would expect to see is the steady-state limit settling near the actual in-flight count, say around 50 permits, rather than parking at the unused 200. The old pool had been advertising more capacity than the system ever consumed, and a large fraction of that headroom only ever got used as queue depth when something went wrong.

Under a sustained downstream latency step, the gradient limiter's short-term RTT diverges from its long-term baseline, the gradient ratio drops below 1.0, and the computed limit contracts over the next tens of seconds. The semaphore starts refusing admission at the edge (what the caller does with that refusal is a separate concern; see any of the standard load-shedding writeups). Painful, but bounded.

The qualitative difference versus the fixed pool: with the adaptive limit, tail latency stays close to baseline because the limiter throttles arrivals before the downstream queues internally. With a fixed pool sized well above the working set, the pool itself becomes the queue, observed p99 climbs to something dominated by queue wait, and it takes minutes (not seconds) for that queue to drain after the underlying latency recovers.

A corollary worth flagging: any load test you run against a service with an adaptive limiter must be open-loop (arrivals independent of completions). A closed-loop test with a fixed number of virtual users will silently throttle itself when the limiter contracts, and the report will read "everything was fine" because no requests were rejected. They were just never sent. Treat that as the measurement-side failure mode of the same feedback loop you just installed.

```
gradient limiter, same downstream latency step:

limit (permits)
                  |  ----  (fixed pool ceiling, unused)
                  |
                  |  ___
                  |     \_____           _______
                  |           \         /
                  |            \_______/
                  +------------------------------- time
                                t0: step    t1: recovery
                                            (limit grows back)

observed p99
                  |
                  |        __
                  |       /  \____
                  |      /        \___
                  |  ___/             \___
                  |                       \___
                  +------------------------------- time
                       t0          t1
```

## Where the gradient approach falls down

It would be irresponsible to pretend the gradient approach is free. Three failure modes are worth knowing.

First, if your downstream is consistently slow rather than transiently slow, the long-term RTT eventually catches up to the short-term RTT and the gradient ratio drifts back to 1.0. The limiter forgets it was ever supposed to be cautious. This is fine if the new slow latency is the new normal and you should be sized for it. It is a problem if you want to remember the old baseline as your aspiration. The fix is usually to clamp the long-term RTT or to use a slowly-decaying minimum rather than an exponentially-weighted average.

Second, the limiter assumes that the latency it observes is mostly downstream. If the latency includes time spent waiting for the limiter's own semaphore, you have a positive feedback loop: more queue wait inflates measured RTT, the gradient drops, the limit shrinks, queue wait gets worse. The standard fix is to measure only the downstream call time, not the time from when the request entered the limiter.

Third, very low traffic breaks both gradient and Vegas. If you only get 2 requests per second, your "short-term" window is dominated by the variance of individual samples. The library implementations usually special-case this with a minimum sample count before adjusting, but if you write your own, make sure you do too.

## What to actually do

If you are running a fixed thread pool or semaphore today against a remote service that has any latency variance at all, replace it. Either family of algorithm will be better than what you have. Start with whichever your platform's standard library supports, tune the smoothing or thresholds against a load test that includes a synthetic latency step, and add metrics on the current limit value so you can see it move.

The number is not actually that interesting once it's adaptive. What's interesting is that the system now has a feedback loop where there used to be a guess, and the guess can finally retire.
