# Why your healthcheck endpoint lies

*a 200 OK is cheap. So is lying*

Every `/healthz` endpoint I have inherited returned 200. Most were lying.

The lie was rarely malicious; it was usually `return Response(status=200)` wired up on day one and never touched again. The service it claimed to represent had since grown a Postgres dependency, a Redis cache, a downstream billing API, and a feature flag service. The healthcheck still returned 200 if the process was breathing. The most expensive version of this I ever watched in the wild: a load balancer kept a dead pod in rotation for six months because the pod's TCP listener was up and `/healthz` was hardcoded to 200. The fleet sat behind a consistent-hash load balancer keyed on user ID, so the same unlucky ~2.5% of users hit the dead pod on every retry and got a uniform failure rate, which is exactly what made it invisible (no spike, no alert, just a flat drag on conversion). Nobody noticed until a finance reconciliation flagged the gap.

This post is about why that happens, and how to build healthchecks that mean something without melting the dependencies they're supposed to be checking.

## The shallow check problem

The default healthcheck most frameworks ship with looks roughly like this:

```python
@app.route("/healthz")
def healthz():
    return {"status": "ok"}, 200
```

This is a process liveness check, dressed up as a service health check. It answers exactly one question: is the HTTP server accepting connections and able to allocate a response? That's it. It tells you nothing about whether the service can do its actual job.

The reason this is dangerous is that it sits at the wrong level. A modern web service is a chain. It accepts a request, talks to a database, maybe hits a cache, calls one or two downstream APIs, possibly writes to a queue, and returns. The user only cares about the chain. The shallow check only verifies the front door.

So you end up in the worst kind of outage: every probe is green, every log line says "healthcheck ok", and the actual service is silently dropping 80% of real traffic because the database connection pool is exhausted. Monitoring stays green because monitoring is looking at the same lying endpoint.

## The naive overcorrection

Once a team gets burned by a shallow check, the next mistake is usually the opposite. They write a "deep" check that touches everything:

```python
@app.route("/healthz")
def healthz():
    db.execute("SELECT 1")
    cache.ping()
    requests.get("https://billing.example.com/healthz", timeout=2)
    requests.get("https://flags.example.com/healthz", timeout=2)
    return {"status": "ok"}, 200
```

This feels rigorous. It is a footgun.

Three things go wrong, often at the same time.

First, the load balancer probes this endpoint every two seconds across, say, fifty pods. That's twenty-five queries per second to your database, your cache, and every downstream API, generated entirely by healthchecks. If the downstream API has a rate limit, you've just spent it on heartbeats. If the database has a connection limit, your healthcheck is now competing with real traffic for slots.

Second, this check is transitively coupled. If the billing API has a hiccup, every service that healthchecks against it goes unhealthy. The load balancer pulls every pod out of rotation. The service is now completely down, because of an outage in a downstream system that maybe only 10% of requests actually use. The blast radius of any failure is now the entire dependency graph.

Third, when one of these checks fails intermittently (and they always do, eventually), you'll get flapping. Pods leaving and rejoining the pool every thirty seconds. Connection pools resetting. Cache warmups happening over and over. Latency spikes. Cascading retries.

The naive deep check makes your system less reliable than the shallow one, because now your healthcheck is a load amplifier and a failure amplifier at the same time.

## Liveness vs readiness vs startup

The fix starts with admitting that "healthcheck" is not one question. It's at least three, and they have different answers and different consumers.

```
                  ┌─────────────────────────────┐
                  │      orchestrator           │
                  │  (k8s, ECS, nomad, etc.)    │
                  └──────┬──────────┬───────────┘
                         │          │
              liveness   │          │   readiness
              "restart   │          │   "send me
               me?"      │          │    traffic?"
                         ▼          ▼
                  ┌─────────────────────────────┐
                  │         service             │
                  └─────────────────────────────┘
                         ▲
              startup    │
              "am I done │
               warming?" │
                         │
                  ┌──────┴──────────────────────┐
                  │  same orchestrator, gated   │
                  │  before the other two       │
                  └─────────────────────────────┘
```

**Liveness** answers: is this process so broken that the only fix is to kill it? Deadlocked event loop, OOM-survivor that's leaking memory, stuck in an infinite GC pause. The action on failure is to restart the container. Liveness should be the shallowest check you have. If liveness checks dependencies, you create a feedback loop where a downstream blip restarts your entire fleet. That is exactly the wrong response.

**Readiness** answers: should the load balancer send this instance traffic right now? This is where dependency-awareness lives, with caveats. A failing readiness check pulls the pod out of rotation but does not restart it. Critically, when readiness fails across all pods, the load balancer's behavior matters a lot. Some return 503 immediately, some hold connections, some fall back to a stale set. Know what yours does before you trust readiness with critical dependencies.

**Startup** answers: has the slow boot finished? Large models loading into memory, JIT warmup, cache pre-population, schema migrations. Without a startup probe, your liveness check fires during boot, the orchestrator thinks the pod is dead, and you get a crashloop on every deploy. Concrete version: a 14B-parameter model takes 90 seconds to load from disk; the default liveness probe starts checking almost immediately and gives up after a few failures around the 30-second mark; every deploy crashloops until someone adds a startup probe. Kubernetes added the startup probe as alpha in v1.16, beta in v1.18, GA in v1.20 for exactly this reason, and it explicitly disables liveness and readiness until it succeeds (https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/). Startup probes give the process a grace period with relaxed criteria, then hand off to liveness once the process is up.

These three are not interchangeable. Most outages I've seen from "bad healthchecks" are actually cases where one endpoint was being used for all three jobs.

## What each check should actually do

Concretely, for a typical web service with a database, cache, and two downstream APIs, here's the shape I reach for:

```python
@app.route("/livez")
def livez():
    # Process-internal only. No I/O.
    # If this returns non-200, the orchestrator restarts the pod.
    return {"status": "ok"}, 200


@app.route("/startupz")
def startupz():
    # Did the slow boot finish? Migrations applied, caches warmed,
    # config loaded. Set once at boot, then this is fast.
    if not boot_state.ready:
        return {"status": "starting", "reason": boot_state.reason}, 503
    return {"status": "ok"}, 200


@app.route("/readyz")
def readyz():
    # Should I receive traffic? Check things this pod actually needs
    # to serve a request. Use cached results, don't hammer dependencies.
    checks = dependency_cache.snapshot()
    failures = [name for name, ok in checks.items() if not ok and is_critical(name)]
    if failures:
        return {"status": "degraded", "failed": failures}, 503
    return {"status": "ok", "checks": checks}, 200
```

The interesting work happens off the request path. Each dependency gets its own long-running poller task, on its own cadence, writing the result into `dependency_cache`. The readiness handler just reads the cache. The load balancer's probe rate and the actual dependency check rate are two completely separate numbers.

```python
async def poll_forever(name, check, interval, timeout):
    while True:
        try:
            await asyncio.wait_for(check(), timeout=timeout)
            dependency_cache.set(name, ok=True)
        except Exception as e:
            dependency_cache.set(name, ok=False, error=repr(e))
        await asyncio.sleep(interval)


async def start_pollers():
    # Each poller runs independently. No gather, no shared cadence.
    asyncio.create_task(poll_forever("db",      check_db,      interval=5,  timeout=2))
    asyncio.create_task(poll_forever("cache",   check_cache,   interval=5,  timeout=1))
    asyncio.create_task(poll_forever("billing", check_billing, interval=30, timeout=3))
    asyncio.create_task(poll_forever("flags",   check_flags,   interval=30, timeout=3))
```

Now your readiness endpoint can be called a thousand times a second and your database still only sees one `SELECT 1` every five seconds. The HTTP probe frequency at the load balancer is decoupled from the actual dependency check frequency behind the handler. The cost of a deep check no longer scales with traffic, or with the orchestrator's probe interval.

The two cadences look like this:

```
  probe cadence (fast)                  poller cadence (slow, per-dep)

  LB ──▶ /readyz ──▶ dependency_cache         background poller ──▶ db
         (every 2s)   (in-memory read,        (every 5s)              │
                       <1ms, no I/O)                                  ▼
                            ▲                                  dependency_cache
                            │                                   (atomic write)
                            └──────── shared map ──────────────────────┘

  LB never touches db, cache, or downstream APIs directly.
  Probe rate and dependency-check rate are independent knobs.
```

## Critical vs non-critical dependencies

The next question is which dependencies count. The naive deep check treats every dependency as load-bearing, which is why one downstream burp takes the whole service offline. In reality, dependencies fall into tiers:

- **Hard dependencies.** The service is useless without them. For a checkout service, that's usually the primary database and the payment API. If these are down, readiness should fail.
- **Soft dependencies.** Used by some requests, but the service can serve a meaningful subset of traffic without them. The recommendation engine, the analytics sink, the search index. If these are down, the service should stay in rotation and return degraded responses for the affected endpoints.
- **Best-effort dependencies.** Telemetry, logging, feature flag refresh. The service might lose visibility but should never go unhealthy because of them.

Encoding this is mostly discipline. A `dependency` decorator that tags each check with a tier, and a readiness handler that only fails on `Tier.HARD`:

```python
@dependency(name="db", tier=Tier.HARD, interval=5)
async def check_db():
    async with db.acquire() as conn:
        await conn.execute("SELECT 1")

@dependency(name="recommendations", tier=Tier.SOFT, interval=15)
async def check_recommendations():
    async with httpx.AsyncClient(timeout=2) as c:
        r = await c.get(f"{REC_HOST}/healthz")
        r.raise_for_status()
```

The readiness handler returns degraded-but-up when soft checks fail, and routes the affected endpoints to a fallback. The load balancer keeps sending traffic. Users hitting the fallback see "recommendations unavailable" instead of a 503. The blast radius of a recommendation outage is now the recommendation feature, not the entire site.

## Fail-closed vs fail-open

There is a class of dependency where you genuinely cannot serve traffic without it. Auth is the canonical example, with one important caveat: this only applies when you have to call the auth service to validate each request. Most modern setups verify JWTs (RFC 7519) locally against a cached JWKS (RFC 7517), which means a short auth-provider blip doesn't actually break authentication, only token issuance and refresh.

In that world fail-open for a bounded window is reasonable and most production systems do exactly that. The fail-closed argument bites hardest when you have no local validation path: the auth provider is unreachable, you cannot prove the caller is who they say they are, and letting requests through would turn an availability incident into a security incident. There, fail-closed is correct: readiness fails, traffic stops, customers see an outage, and nobody gets unauthenticated access.

For most other dependencies, fail-open with a degraded mode is better. Cache down? Serve from origin, slower. Recommendation engine down? Show the popular-items fallback. Search index stale? Return a banner saying "results may be out of date."

The rule of thumb I use: fail-closed when the failure mode of fail-open is worse than the outage. Fail-open with a clear degraded path everywhere else. And write down which mode each dependency uses, because the next person on call will not be able to figure it out from the code.

## The probe-cost problem

Even with cached dependency checks, the probes themselves cost something. Kubernetes probe defaults are `periodSeconds=10`, `timeoutSeconds=1`, `failureThreshold=3`, `successThreshold=1`, `initialDelaySeconds=0` (https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/), which sounds harmless until you multiply across a real fleet with aggressive intervals. The minimum supported `periodSeconds` is 1; sub-second probes are not allowed.

At small scale this is a rounding error. But the moment someone tightens the probe interval to chase faster failover (2-second probes show up in latency-sensitive setups), the math changes fast. The probe-traffic load on each pod is `(probes_per_pod * checks_per_probe) / periodSeconds`, and the fleet total scales linearly with pod count:

| Fleet size | periodSeconds | Probes per pod | Fleet probe rate | Notes |
|-----------:|--------------:|---------------:|-----------------:|-------|
|         50 |            10 | liveness + readiness | 10 rps | rounding error |
|        500 |            10 | liveness + readiness | 100 rps | still fine |
|        500 |             2 | liveness + readiness | 500 rps | logs start to drown |
|       2000 |             2 | liveness + readiness | 2000 rps | before a single user shows up |
|       2000 |             2 | startup only (during boot window) | 1000 rps | Kubernetes disables L/R until startup succeeds |

A fleet of 2000 pods with both a liveness and a readiness probe at 2-second intervals is 2000 requests per second of pure healthcheck traffic, before a single user shows up. That is noise in your access logs, noise in your latency histograms, noise in your distributed traces, and a non-trivial chunk of every pod's CPU spent answering probes. If your readiness handler does any real work (even a cache read with JSON serialization), it adds up.

Two small fixes help a lot:

1. **Don't log healthcheck requests.** Most logging middleware will happily emit a structured log line for every `/livez` hit. Skip them at the middleware level. Your logs will be 30% smaller and you'll actually be able to find real requests.
2. **Don't trace healthcheck requests.** Same reason. They're not interesting, they sample your trace budget away from real traffic, and they make every dashboard noisier.

```python
@app.middleware("http")
async def skip_healthcheck_logging(request, call_next):
    if request.url.path in ("/livez", "/readyz", "/startupz"):
        request.state.skip_logging = True
        request.state.skip_tracing = True
    return await call_next(request)
```

Tiny change, surprisingly large quality-of-life improvement.

## The failure modes healthchecks specifically get wrong

Healthcheck handlers have their own peculiar failure modes that generic "test the failure path" advice doesn't cover. Two in particular show up everywhere:

**The slow-and-sad case.** The dependency isn't down, it's just taking 30 seconds to answer. A naive check with no timeout, or a timeout longer than the probe interval, will pile probes on top of each other. Coroutines stack up, connection pools drain, the process OOMs, and now the healthcheck itself is the outage. Verify that every check has a timeout strictly shorter than the poller interval, and that hitting the timeout actually flips the cached state to unhealthy rather than leaving the previous value stuck.

**The flapping case.** A dependency goes up and down every thirty seconds. Without hysteresis, readiness toggles in lockstep: pod out of rotation, pod back in, pod out, pod back in. Connection pools reset on every flap, cache warmups thrash, downstream services get a burst of reconnects each time the pod rejoins. Add a small "must be healthy for N consecutive polls before flipping back to ready" rule, even just two or three samples. It costs you a few seconds of extra downtime on recovery and saves you from the worst kind of self-inflicted DDoS.

```python
class Hysteresis:
    def __init__(self, healthy_threshold=3, unhealthy_threshold=1):
        self.healthy_threshold = healthy_threshold
        self.unhealthy_threshold = unhealthy_threshold
        self.consecutive_healthy = 0
        self.consecutive_unhealthy = 0
        self.state = "unhealthy"  # start closed; require N healthy samples to enter rotation

    def observe(self, ok: bool) -> str:
        if ok:
            self.consecutive_healthy += 1
            self.consecutive_unhealthy = 0
            if self.state == "unhealthy" and self.consecutive_healthy >= self.healthy_threshold:
                self.state = "healthy"
        else:
            self.consecutive_unhealthy += 1
            self.consecutive_healthy = 0
            if self.state == "healthy" and self.consecutive_unhealthy >= self.unhealthy_threshold:
                self.state = "unhealthy"
        return self.state
```

Note the asymmetry: fail fast (one bad sample flips you out), recover slow (three good samples to flip back). That matches what you actually want, which is to take a misbehaving pod out quickly and only let it rejoin when you have evidence it stayed fixed.

A third one worth a sentence: orchestrators sometimes probe `/readyz` and `/livez` from different network paths (sidecar vs node-local), and a check that works from one path can fail from the other. Probe from both before you trust the result.

These failure modes only surface when you break things deliberately. Verify your healthcheck under fault injection, or the dashboard will read green during the next outage.
