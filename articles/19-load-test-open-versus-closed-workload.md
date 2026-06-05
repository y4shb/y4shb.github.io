# Why your load test lies: open versus closed workload models

*a 12ms p99 that turns into 340ms the moment you stop politely waiting*

There is a particular flavor of performance regression that only shows up in production. The load test was green. The dashboards were green. The team shipped, and within twenty minutes of real traffic the latency graphs went vertical. Nobody had introduced a bug. The load test was just answering a different question than the one anyone thought it was answering.

The question it was answering: "how fast does this service respond when I send a request, wait politely for the response, and only then send the next one?" The question everyone thought it was answering: "how does this service behave when real users keep arriving regardless of how slow it is?"

These are not the same question. The first is a closed-loop model. The second is an open-loop model. The gap between them is where p99 numbers go to die.

## The setup

Picture a recommendation service called `dovetail`. It serves personalized product cards. The team runs a nightly benchmark with a tool I will call `loadwhip` (any closed-loop tool with concurrency knobs works the same way). The script looks roughly like this:

```python
# nightly_bench.py - the seductive lie
import asyncio, httpx, time

CONCURRENCY = 200
DURATION_S = 60
URL = "http://dovetail.internal/cards?user=42"

async def worker(client, results):
    end = time.monotonic() + DURATION_S
    while time.monotonic() < end:
        t0 = time.monotonic()
        r = await client.get(URL)
        results.append((time.monotonic() - t0) * 1000)

async def main():
    results = []
    async with httpx.AsyncClient(timeout=10) as client:
        await asyncio.gather(*[worker(client, results) for _ in range(CONCURRENCY)])
    results.sort()
    p50 = results[len(results) // 2]
    p99 = results[int(len(results) * 0.99)]
    print(f"requests={len(results)} p50={p50:.1f}ms p99={p99:.1f}ms")

asyncio.run(main())
```

This reports something like:

```
requests=482103  p50=4.2ms  p99=12.1ms
```

A 12ms p99 at 200 concurrent workers. Ship it.

The next morning real traffic arrives. Real traffic does not consist of 200 polite workers. It consists of an arrival process: a request shows up roughly every N microseconds, and it shows up whether or not the previous one has finished. The same service, under the same total request rate, suddenly reports a p99 of 340ms. Everyone is confused. The benchmark hasn't changed. The service hasn't changed. Only the model has.

## Closed loop versus open loop

The terminology comes from queueing theory, where it has been understood for roughly sixty years and ignored for roughly fifty-nine. The two models look like this:

```
CLOSED LOOP (what most load testers do by default)
+---------+   request    +---------+
| worker  | -----------> | service |
| (waits) | <----------- |         |
+---------+   response   +---------+
   |  ^
   |  | "I will not send the next one
   v  |  until I see the response"

OPEN LOOP (what real users do)
+---------+   request    +---------+
| arrival | -----------> | service |
| process |              |         |
+---------+              +---------+
   |
   | new request fires on a schedule,
   v independent of any response
```

In the closed model, the load generator has a fixed number of "virtual users" and each one is a strict request/response loop. If the service slows down, the workers slow down with it, and the offered load drops automatically. The system can never overload itself because the test is implicitly back-pressured.

In the open model, request arrivals are independent of service completions. If the service slows down, requests pile up. Queue depth grows. Latency for the request at the back of the queue includes the wait for everything in front of it. This is what real users do: when you load a product page, your browser fires the request whether or not the previous user's request has finished.

The closed model measures service time. The open model measures response time (service time plus queue wait). For an unloaded system these are identical. For a loaded system they diverge by orders of magnitude.

## Why p99 looks healthy in closed mode

Here is the mechanism in one sentence: closed-loop testers self-throttle on slow responses, so the slow responses never get to interact with each other.

Imagine `dovetail` has a GC pause every few seconds that adds 200ms to about 0.5% of responses. In the closed test, when a worker hits a slow response it just... waits. For 200ms. During that time, that worker is not sending requests. The 199 other workers continue at normal speed. The slow response gets recorded as 200ms. It is one bad sample out of many. The 99th percentile barely moves.

Now run the same workload in open mode at the same average rate. The GC pause hits. Arrivals keep arriving while the service is stalled, so one 200ms bad event becomes many bad responses, each carrying its own wait. The p99 craters. (The runtime mitigation, adaptive concurrency limits, is a separate story; see blog #14. Here the point is that the test never surfaced the problem in the first place.)

This is what Gil Tene named "coordinated omission" in his 2013 talk: the load generator and the service have implicitly coordinated to omit the consequences of slow events. The bad samples that should exist were never generated, because the workers that would have generated them were busy waiting.

## What the corrected number looks like

When we rerun the `dovetail` benchmark with a corrected, open-model generator firing at the same throughput, here is a representative example of what we see (the numbers below are illustrative for this fictional service, though the order-of-magnitude shape is consistent with published Coordinated Omission demonstrations by Gil Tene and ScyllaDB):

| Metric | Closed loop (200 workers) | Open loop (matching rate) |
|---|---|---|
| Throughput | 8,035 rps | 8,035 rps |
| p50 | 4.2 ms | 5.1 ms |
| p90 | 6.9 ms | 18 ms |
| p99 | 12.1 ms | 340 ms |
| p99.9 | 18.4 ms | 1,820 ms |
| Max | 220 ms | 4,100 ms |

Throughput matched because `dovetail` had enough capacity at 8,035 rps; if the open-loop test had targeted higher than the service could sustain, achieved throughput would have fallen below target and the queue would have grown unbounded. p50 is barely different. p99 is 28x worse. p99.9 is roughly 100x worse. The service has not changed. The benchmark just stopped lying.

The shape of the divergence is the diagnostic: if your open and closed numbers differ a lot at the tail and very little at the median, you have a queueing problem hiding behind a closed-loop test. If they differ at both, you also have a throughput ceiling problem.

## How to actually configure an open-loop test

The good news is that the major modern load testers all support open-loop generation. You just have to ask for it explicitly, because the defaults are almost always closed-loop. A few that I have used:

- `wrk2`, written specifically by Gil Tene to address coordinated omission. Pass `-R <rate>` and it will fire at that rate regardless of response time and record latency including the would-be wait.
- `k6` has `constant-arrival-rate` and `ramping-arrival-rate` executors. The default `constant-vus` executor models a fixed pool of looping virtual users, which is closed-loop in effect for single-request scenarios. The arrival-rate executors are open-loop.
- `vegeta` is open-loop by default. `vegeta attack -rate=8000/s -duration=60s` does the right thing without ceremony.
- `Gatling` has `constantUsersPerSec` and `rampUsersPerSec`. Its `constantConcurrentUsers` and `rampConcurrentUsers` are closed-loop (the `injectClosed` model); the open-model injection steps include `atOnceUsers`, `rampUsers`, `constantUsersPerSec`, and `rampUsersPerSec` ([docs.gatling.io/concepts/injection/](https://docs.gatling.io/concepts/injection/)).

Here is the same benchmark rewritten in `k6` as an open-loop test:

```javascript
// nightly_bench_open.js
import http from 'k6/http';

export const options = {
  scenarios: {
    real_traffic: {
      executor: 'constant-arrival-rate',
      rate: 8000,           // 8000 requests/sec, regardless of latency
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 500,  // pool to draw from
      maxVUs: 4000,          // ceiling if service gets slow
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<50'], // this is what we actually care about
  },
};

export default function () {
  http.get('http://dovetail.internal/cards?user=42');
}
```

Three things to notice. First, `rate` is in requests per second, not virtual users. Second, `preAllocatedVUs` and `maxVUs` are a pool the executor can draw from when the service slows down. Set `maxVUs` high enough that the generator never becomes the bottleneck (a good rule of thumb: at least `rate * worst_acceptable_latency_seconds * 4`). This is Little's law (VUs = rate * latency) with a 4x safety factor; if latency triples during a degradation you still have generator headroom. Third, the threshold is on response time, which now includes queue wait.

If you have to stay in a closed-loop tool for organizational reasons, `wrk2` will at least correct the recorded latencies by back-filling synthetic samples when a response takes longer than the inter-arrival interval. Its README frames this as "constant throughput, correct latency recording" and Coordinated Omission correction, measuring latency "from the time the transmission should have occurred" and tracking both corrected and "uncorrected" histograms ([github.com/giltene/wrk2](https://github.com/giltene/wrk2)). It is not as good as a real open-loop test, but it is dramatically better than a naive closed-loop one.

## The diagnostic checklist

If you inherit a load test and want to know whether it is lying to you, here is what to check, roughly in order of how much time it saves:

1. Look at the tool invocation. Is it `vus`, `concurrency`, `threads`, or `clients`? Closed loop. Is it `rate`, `rps`, `arrival-rate`, or `qps`? Open loop.
2. Check whether the test reports a target rate or an achieved rate. Closed-loop tools usually report achieved rate, because the rate is whatever the service let them have. Open-loop tools report both, and the gap between target and achieved is the first thing you should look at.
3. Plot p50 against p99 over time. If they move together, you are measuring service time. If p99 spikes while p50 stays flat, you are measuring queue wait, which is the real signal.
4. Compare the maximum response time to the test duration divided by the concurrency. In a closed-loop test, the max can never exceed the test duration (one worker can produce at most one outstanding slow request). If you see a max that is suspiciously close to that ceiling, your test was concurrency-bound.

## When closed loop is actually correct

There is a narrow set of cases where closed-loop modeling is the right answer: when your real workload is also closed-loop. Internal RPC chains where a calling service has a strict connection pool and applies its own backpressure are genuinely closed-loop. Batch pipelines processing fixed-size chunks are closed-loop. A queue worker with `prefetch=N` is closed-loop with N.

For these systems, a closed-loop test with `concurrency = real production concurrency` is the right model, and an open-loop test would overstate tail latency by simulating queue conditions that physically cannot occur.

The mistake is using closed-loop tests for inherently open-loop workloads: anything user-facing, anything triggered by external events, anything fronting a CDN or a mobile app. If your service is on the receiving end of an arrival process, you have to test it with one.

## What the `dovetail` team actually did

In our illustrative scenario, after the open-loop rerun produced the 340ms p99, the investigation was short. The GC log showed periodic ~200ms pauses. The fix was prosaic: switched the JVM flags, tuned the heap, and the open-loop p99 dropped by roughly an order of magnitude. The closed-loop p99 barely moved, which would have been mistaken for an unremarkable tuning win in the old benchmark. The real win, the dramatic improvement at the tail under realistic conditions, was only visible because the test was finally honest.

The team also added a CI guard. The nightly benchmark now runs both models and fails if the open-loop p99 exceeds 50ms or if the gap between closed and open p99 exceeds 3x. The second check is the more interesting one: it catches new queueing pathologies before they have a chance to hurt anybody, even if the absolute number still looks fine.

Run your load test both ways at least once. If the numbers agree, you have learned something. If they disagree, you have learned something more important: which of them was answering the question your users will be asking.
