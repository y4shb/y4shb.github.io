# Error budget math when your SLO has correlated dependencies

*multiplying availability numbers across services assumes failures are independent. They are not, and the gap is where your pager lives*

The first time someone showed me the math for composing service availability, I nodded along because it looked like statistics I half-remembered from school. Service A is 99.9, service B is 99.9, your endpoint calls both, so your endpoint is 0.999 times 0.999 which rounds to 99.8. Cute. Everyone writes it on a whiteboard, books a quarterly review, and goes back to fighting fires.

The problem is that this formula is true only when the failure events are independent, and almost nothing in a real system is independent. The moment two services share a database, an auth provider, a control plane, a region, a deployment pipeline, or a single overworked SRE, their failure probabilities couple. The naive product can lie in either direction depending on how the per-service SLIs were measured: if each sibling's published availability already includes shared-ancestor downtime, the product double- and triple-counts that downtime and understates the real availability; if each sibling's SLI silently excludes ancestor-caused failures, the product flatters reality and overstates availability. Either way the arithmetic is fiction; the only question is which sign of fiction you are buying.

This post works through that gap with a running example: a search endpoint called `/v1/search/items` that depends on three services, all of which lean on the same identity service for token validation. I will show why the textbook calculation says 99.9 and why the honest ceiling is closer to 99.5, and what to do about it before someone hands you a postmortem.

## The textbook formula and where it lies

For an endpoint that requires `n` independent dependencies to succeed, the combined availability is the product of the individual availabilities. If each dependency is `A_i`, the endpoint sees:

```
A_endpoint = A_1 * A_2 * A_3 * ... * A_n
```

Three dependencies at 99.95 each gives `0.9995^3` which is roughly 99.85. Comfortable enough to commit to a 99.9 user-facing SLO if you have a little client-side retry headroom.

The hidden assumption is that the events "service 1 is down" and "service 2 is down" are statistically independent. The joint probability of both being down is the product of the individual probabilities only when knowing one tells you nothing about the other. In practice, knowing that service 1 is down often tells you a great deal about service 2, because they share fate.

A more honest formula for two services with a shared failure mode is:

```
P(both up) = P(both up | shared healthy) * P(shared healthy)
           + P(both up | shared down)    * P(shared down)
```

If a shared dependency being down forces both downstreams to fail, the second term collapses to zero and the joint availability is bounded above by the shared dependency's availability. Without a fallback path, you cannot be more available than your weakest common ancestor. (Fallbacks exist; caching positive token validations is the canonical one, and we will get to it. But absent a fallback, the ceiling is hard.)

## The running example

Endpoint: `/v1/search/items`. Hits three services in sequence:

- `query-planner`: parses the query, decides which indices to hit. Calls `identity` on every request to validate the caller's token.
- `index-shard-router`: fans out to the right shards. Calls `identity` to authorize cross-tenant lookups.
- `result-ranker`: scores and orders the candidate set. Calls `identity` to pull the caller's preference vector.

Each of the three sibling services has a published 99.95 availability over the trailing 28 days. The identity service has a published 99.9. The naive multiplication says:

```
0.9995 * 0.9995 * 0.9995 = 0.9985  -> 99.85% endpoint availability
```

This is the number someone put in the SLO doc. It is wrong, and the way it is wrong is that none of those three 99.95 numbers are actually independent of the 99.9 identity number.

```
                    +-----------------+
                    |    identity     |  99.90
                    +--------+--------+
                             |
        +--------------------+--------------------+
        |                    |                    |
        v                    v                    v
+---------------+   +-----------------+   +-----------------+
| query-planner |   | index-shard-rtr |   |  result-ranker  |
|     99.95     |   |      99.95      |   |      99.95      |
+-------+-------+   +--------+--------+   +--------+--------+
        |                    |                     |
        +--------------------+---------------------+
                             |
                             v
                  /v1/search/items endpoint
```

The 99.95 numbers for the three siblings already include the downtime caused by identity outages, because their availability is measured at their own edge. When identity goes down, all three siblings go down with it, and that joint downtime is being counted three separate times in the multiplication.

## Decomposing the failure modes

The clean way to think about this is to separate each sibling's downtime into two buckets:

1. Downtime caused by the shared dependency (identity).
2. Downtime caused by anything else (its own bugs, its own host failures, its own deploys).

Let `D_shared` be the fraction of time identity is down, and let `D_i_own` be the fraction of time sibling `i` is down for its own reasons. Assume the "own" failures are roughly independent across siblings, which is a much weaker assumption than full independence.

Each sibling's measured availability is roughly:

```
A_i = 1 - (D_shared + D_i_own)
```

If identity is 99.9, then `D_shared` is 0.001. If the sibling reports 99.95, then `D_shared + D_i_own = 0.0005`. This is already impossible. The sibling cannot be down for 0.0005 of the time if the dependency it requires is down for 0.001 of the time. Either the sibling has some fallback path that lets it survive identity outages, or the measurement excludes them, or one of the numbers is wrong.

In practice the answer is usually "the measurement excludes them." The sibling's SLI is computed against requests that the sibling itself processed, and during an identity outage the sibling returns fast 401s that look like clean responses to the sibling's own metrics. The customer sees them as failures; the sibling's dashboard sees them as success. This is a different blog post, but it is worth flagging because it means your published SLOs are often more flattering than reality.

Assume for the example that the siblings are honest and report end-to-end availability including identity-caused failures. Then to get the joint endpoint availability we want:

```
A_endpoint = P(all three siblings up at the same time)
           = P(identity up) * P(all three "own" components up | identity up)
           = (1 - D_shared) * (1 - D_1_own) * (1 - D_2_own) * (1 - D_3_own)
```

With `D_shared = 0.001` and each `D_i_own = 0.0005 - 0.001 = -0.0005`, the math breaks. The published 99.95 was either wrong, over-counted, or measured in a way that hides identity-caused failures. To get a coherent example, assume identity is genuinely 99.9 and each sibling has 99.99 "own" availability. Then each sibling's realistic end-to-end measured availability is:

```
A_i = (1 - 0.001) * (1 - 0.0001) = 0.999 * 0.9999 = 0.9989
```

So a sibling claiming 99.95 with a 99.9 dependency is either lying, fault-tolerant against identity outages, or counting differently than you think. From here on we use the realistic 99.89% sibling number rather than the published 99.95%.

## The actual joint availability

With the corrected sibling availability of 99.89, the naive product is:

```
0.9989^3 = 0.9967  ->  99.67%
```

Already lower than the 99.85 we started with. But the joint availability with shared failure mode is not the product. It is:

```
P(all three up) = P(identity up) * P(all three own components up)
                = 0.999 * (0.9999)^3
                = 0.999 * 0.99970003
                = 0.99870
```

So the honest endpoint availability is 99.87, not 99.85 and definitely not 99.9. Notice that this is actually slightly higher than the naive product of the realistic sibling numbers, because that product was triple-counting identity downtime. The shared-dependency math gives a higher availability number than naive multiplication of end-to-end SLIs, because the identity outage is now counted once instead of three times.

Now flip one variable. Say identity is closer to 99.5 because it has a noisy quarter and a regional event ate two hours of budget. Recompute:

```
P(all three up) = 0.995 * (0.9999)^3
                = 0.995 * 0.99970003
                = 0.99471
```

You are at 99.47. Your SLO says 99.9. You are burning more than five times your monthly budget every month for as long as identity stays at 99.5. The naive product would have said:

```
A_i = 0.995 * 0.9999 = 0.99490
0.99490^3 = 0.9848  ->  98.48%
```

The naive number screams "you are toast." The shared-dependency number says "you are bad but not that bad." In both cases the team's published 99.9 SLO is fiction; the gap between them is whether the budget hole is roughly 5x or 15x.

## A working calculator

Here is the kind of script I keep in a `tools/` directory and run before every quarterly SLO review. It takes a tree of dependencies with shared ancestors and prints the realistic ceiling.

```python
from dataclasses import dataclass, field

@dataclass
class Dep:
    name: str
    own_availability: float          # availability ignoring shared deps
    shared: list = field(default_factory=list)  # list[Dep]

def joint_availability(siblings):
    """
    Compute P(all siblings up) accounting for shared ancestors.
    Assumes 'own' failures are independent across siblings.
    """
    # Collect all unique shared ancestors.
    # Assumes all references to a given shared dep use the same object;
    # if two siblings declare the same name with different own_availability,
    # the last write wins. Add an assertion in production.
    shared_set = {}
    for s in siblings:
        for dep in s.shared:
            if dep.name in shared_set:
                assert shared_set[dep.name] is dep, (
                    f"conflicting definitions for shared dep {dep.name!r}"
                )
            shared_set[dep.name] = dep
    shared = list(shared_set.values())

    # P(all shared up) = product of shared availabilities
    p_shared_all_up = 1.0
    for d in shared:
        p_shared_all_up *= d.own_availability

    # P(all siblings' own components up)
    p_own = 1.0
    for s in siblings:
        p_own *= s.own_availability

    return p_shared_all_up * p_own

identity = Dep("identity", own_availability=0.999)
planner = Dep("query-planner",     own_availability=0.9999, shared=[identity])
router  = Dep("index-shard-router", own_availability=0.9999, shared=[identity])
ranker  = Dep("result-ranker",     own_availability=0.9999, shared=[identity])

a = joint_availability([planner, router, ranker])
# Using a 30-day month; align with your SLO window
# (28-day rolling is also common).
budget_minutes_per_month = (1 - a) * 30 * 24 * 60
print(f"endpoint availability: {a:.5f}")
print(f"monthly downtime: {budget_minutes_per_month:.1f} min")
```

For the 99.9 identity case this prints 99.87 and about 56 minutes a month. For the 99.5 identity case it prints 99.47 and about 230 minutes a month. Run this against your real numbers before you commit to the SLO, not after the first month of burn.

## What to do about it

A few things, in rough order of effort.

**Set the SLO at the honest ceiling, not the aspirational one.** If your shared ancestor is 99.9, you cannot promise 99.95 to your callers without a fallback that survives the ancestor being down. Promising it anyway just means you spend every all-hands explaining a hole that is structurally impossible to close.

**Track the ancestor's availability as a leading indicator.** When identity's trailing-7 starts to slip, your endpoint's trailing-28 is going to slip a few weeks later. Put the ancestor on the same dashboard as your endpoint, with the same color coding. Engineers should not have to click through three tiers to figure out why their budget is bleeding. The routing problem this creates (a single ancestor outage firing every downstream SLO alert at once) is a separate concern; this post focuses on the math, and routing is covered elsewhere.

**Build a fallback path for the ancestor where possible.** For identity specifically, this often means caching positive token validations for some short window so a 30-second identity blip does not turn into 30 seconds of universal 401s. The cache has its own risks (revoked tokens stay valid for the cache lifetime) but the tradeoff is usually worth it for read paths. Do not cache for write paths or anything that grants new access.

**Compute and publish a "minus shared" availability number.** Alongside your headline SLO, publish the availability of your endpoint excluding shared-ancestor downtime. This lets you separate "we are slow because identity is having a quarter" from "we are slow because we shipped a bad deploy." Without this split, every postmortem turns into a fight about whose fault it was.

**Stop letting downstream SLIs hide upstream failures.** If your sibling service measures availability against requests it actually saw, identity outages disappear from its dashboard. Add a synthetic that hits the sibling through the full request path including auth, and use that for the SLI. The numbers will be uglier, but they will be true.

## The thing nobody puts in the doc

The arithmetic above is not hard. A junior engineer can derive it in twenty minutes. The reason every team's published SLO is too optimistic is not that the math is too advanced; it is that nobody wants to be the person who writes "99.5" in the cell where leadership expected "99.9." The naive multiplication is a polite fiction that lets everyone go back to their roadmap.

The cost of the polite fiction is paid in 3 AM pages and quarterly explanations of why the burn rate alert went off. If you do the honest math up front, you get to choose between investing in fault tolerance, lowering the published number, or eating the burn. You get to make that choice on a sunny Wednesday instead of in a postmortem with three vice presidents on the call. It is not glamorous work, but neither is explaining for the fourth time why your endpoint cannot be more available than the auth service it depends on.
