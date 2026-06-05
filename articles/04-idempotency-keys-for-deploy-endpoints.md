# Idempotency keys for deploy and provisioning endpoints

*stripe shipped this for cards in the mid-2010s. Your control plane is still rolling the dice*

Pick any reasonably mature payments SDK and you will find the same pattern: every mutating request takes an `Idempotency-Key` header, the server stores the response keyed by that header for some window, and a retry within the window returns the original response instead of charging the card again. Well-trodden ground: blog posts, RFCs, conference talks, and an in-flight IETF effort to register the header (`draft-ietf-httpapi-idempotency-key-header` in the IETF HTTPAPI working group, last revision expired, not yet an RFC; see datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/). This post is about the wire format: HTTP header, per-key fingerprint, response cache, Stripe lineage, and how to apply it to infra. (Its on-disk cousin, where you write a per-operation token to a journal before the side effect, is a different shape of the same idea and lives in its own post.)

Now go look at the deploy endpoint on whatever internal control plane you talk to. Or the provisioning API for your test fleet. Or the firmware flash endpoint on the BMC. Odds are the contract is "POST and pray, poll a status URL, and if the network burped, good luck."

This is bizarre. The cost of double-charging a card is a chargeback and an angry email. The cost of double-flashing firmware mid-boot is a brick that needs a service tech. The cost of double-provisioning a worker is two workers fighting over a hostname, or a leaked lease that holds capacity hostage for a week.

Infra endpoints need idempotency more than payment endpoints, not less.

## The shape of the problem

Take a small fictional service called `leasebroker` that hands out worker nodes from a pool. Clients call:

```
POST /v1/workers
{
  "image": "worker-base:2025.11",
  "cpu": 16,
  "memory_gb": 64,
  "labels": {"team": "ml-eval", "purpose": "bench"}
}
```

`leasebroker` allocates a node from the pool, writes a lease into its database, calls out to the hypervisor to boot the image, and returns:

```
201 Created
Location: /v1/workers/wkr-7Q2K9
{
  "id": "wkr-7Q2K9",
  "state": "booting",
  ...
}
```

Failure modes that produce a retry from the client's perspective:

1. The request never makes it. TCP RST, DNS hiccup, LB 502. Client never sees a response.
2. The request makes it, the server processes it, the response is lost on the way back. Client sees a timeout.
3. The request makes it, processing is in flight, the client gives up before the response returns.
4. The client process crashes after sending, and a supervisor restarts it without knowing whether the previous attempt landed.

In cases 2, 3, and 4 the server already did the work; in case 1 it did not. From the client's vantage these are indistinguishable, so the client retries. Without idempotency, your fleet grows a phantom worker every time a flaky link causes a retry. You will not notice until the bill arrives or the pool runs dry.

## A workable key scheme

The Stripe-style contract is the right starting point and you mostly do not need to invent anything new. Keep the wire format boring:

```
POST /v1/workers
Idempotency-Key: 7c3f5d1e-91a4-4b8c-9f02-1c4a8e5b6d10
Content-Type: application/json

{ ...body... }
```

Rules of the road:

- The key is whatever opaque string the client wants, up to some sane length. 128 chars sits comfortably inside the per-header limits of common reverse proxies (nginx's `large_client_header_buffers` defaults to 8 KB per single header field, Envoy defaults to 60 KiB for total request headers), so you stay clear of 431/414 territory even with other ambient headers. UUIDv4 is the obvious default. Do not let it be the empty string. The in-flight IETF draft (`draft-ietf-httpapi-idempotency-key-header`, HTTPAPI WG) is worth following.
- The key is scoped per principal and per endpoint. The same key from two different API tokens is two different keys. The same key sent to `POST /v1/workers` and `POST /v1/workers/{id}/reboot` is two different keys. Otherwise key collisions across tenants are a denial-of-service vector.
- The server stores the key, a request fingerprint, and the eventual response for a configurable window. 24h covers any realistic client retry budget (CI jobs retrying the next night, humans back from a meeting) and matches Stripe's v1 API retention. Anything shorter than your worst-case client retry budget is wrong.
- Subsequent requests with the same key return the stored response. Always. Even if the underlying resource has since been deleted.

The fingerprint is the part most implementations get wrong, so let us dwell on it.

## The "request fingerprint" gotcha

A naive implementation stores only the key and the response. A client sends key `K` with `{"cpu": 16}`, gets back `wkr-7Q2K9`. Later the same client sends key `K` with `{"cpu": 128}`. What should happen?

Returning `wkr-7Q2K9` is dangerous: the client thinks it got a 128-CPU worker. Allocating a new worker is dangerous: the contract said "this key is idempotent."

The right answer is to detect the mismatch and return `409 Conflict` with a body that says "this idempotency key was previously used with a different request payload." Compute a stable hash of the canonicalized request body (sorted JSON keys, normalized whitespace) when you first see the key, store it, and compare on every reuse.

A reasonable record looks like:

```
{
  "key": "7c3f5d1e-91a4-4b8c-9f02-1c4a8e5b6d10",
  "principal": "tok_abc123",
  "endpoint": "POST /v1/workers",
  "request_hash": "sha256:8e3a...",
  "state": "completed",          // or "in_flight"
  "response_status": 201,
  "response_body": "{...}",
  "response_headers": {...},
  "created_at": "...",
  "expires_at": "..."
}
```

The `state` field matters for the next problem.

## Concurrent retries to the same key

Client sends a request with key `K`, times out at 5 seconds, retries. The original is still being processed. Now two in-flight requests share the same key. If both threads check the store, see no record, and proceed, you have provisioned two workers from one logical request.

The fix is a small state machine with the store doing the locking:

```
INSERT INTO idempotency (key, principal, endpoint, request_hash, state)
VALUES (?, ?, ?, ?, 'in_flight')
ON CONFLICT (key, principal, endpoint) DO NOTHING
RETURNING (xmax = 0) AS inserted;
```

The `RETURNING (xmax = 0)` trick is how you tell "I won the insert" from "someone else got here first": Postgres sets `xmax` to 0 on a freshly inserted row, nonzero when the conflict path was taken. Without it (or an equivalent rowcount check), naive callers will assume the INSERT succeeded and march on. If you own the request, process it. Otherwise look up the existing row. Three cases:

1. `state = 'completed'`, hash matches: return the stored response.
2. `state = 'completed'`, hash differs: return 409.
3. `state = 'in_flight'`: return `409 Conflict` with a `Retry-After` header, or block with a bounded wait, or return `425 Too Early`. Pick one and document it. The worst option is to silently proceed.

Visualized as a race between two concurrent clients sending the same key:

```
  client A                store                  client B
     |                      |                       |
     |-- INSERT K, in_flight ->|                    |
     |     OK (owns request)   |                    |
     |                      |<-- INSERT K, in_flight |
     |                      |    CONFLICT (no-op)   |
     |                      |<-- SELECT K           |
     |                      |    row: in_flight     |
     |                      |--> 409 Retry-After    |
     |-- processing...      |                       |
     |-- store.complete K ->|                       |
     |     row: completed   |                       |
     |                      |<-- SELECT K (B retry) |
     |                      |    row: completed     |
     |                      |--> stored response    |
```

A only wins the insert because of `ON CONFLICT DO NOTHING`; B's path through the three-case lookup is the entire reason that branch exists.

I have seen "block and wait" implemented as `SELECT ... FOR UPDATE` against the row. Tempting, because the client gets the right answer without retrying. Also a great way to exhaust your DB connection pool the first time a slow upstream causes a retry storm. Default to a fast 409 and let the client back off.

The `INSERT ... ON CONFLICT DO NOTHING` above is the create-time flavor of optimistic locking: the row itself is the lock. The same shape (compare-and-set on a version column) generalizes to any contested state transition, which I cover in the post on state machines for long-running operations.

## What happens when the handler crashes mid-flight

A subtle failure mode hides in the state machine above. The handler inserts `state='in_flight'`, starts work, dies (process killed, pod evicted, panic in step 2). The row stays. Every retry within the expiry window hits case 3 and gets `409 Conflict` forever. The client is locked out until the record expires, possibly 24 hours away.

You need a short TTL on the `in_flight` state itself, separate from the 24h response cache. Five minutes is reasonable for fast operations, longer for genuine long-runners. The check becomes:

```
state = 'in_flight' AND now() - started_at < in_flight_ttl  -> 409
state = 'in_flight' AND now() - started_at >= in_flight_ttl -> treat as free, attempt to claim
```

"Attempt to claim" is again an optimistic update: `UPDATE ... SET started_at = now() WHERE key = ? AND state = 'in_flight' AND started_at = ?`. Whoever wins owns the next attempt. The loser falls through to the normal lookup.

The full state machine for an idempotency record:

```
        +---------+
        |  none   |<--------------+
        +---------+               |
             |                    | TTL expired
             | INSERT ON CONFLICT | or sweeper
             v                    |
       +-----------+              |
       | in_flight |--------------+
       +-----------+
          |    |
 complete |    | handler error / panic
          v    v
     +-----------+   +--------+
     | completed |   | failed |--> retry -> in_flight
     +-----------+   +--------+
          |
          | window expires
          v
        none
```

The `none -> in_flight` edge is the atomic `INSERT ON CONFLICT`. The `in_flight -> none` edge via TTL is the safety valve above; without it a crashed handler locks the key for the full response-cache window.

A stronger version actively marks the row `failed` on terminal failure (uncaught exception, panic) so retries do not wait for the TTL. This works with a top-level `defer`/`finally` you trust; it does not when the process is hard-killed. Do both. The TTL is your safety net for cases the cleanup path cannot cover.

## The TOCTOU trap in check-then-act handlers

Idempotency at the HTTP layer is necessary but not sufficient. The handler itself needs to be safe against partial execution.

Consider the naive provisioning handler:

```python
def provision_worker(req):
    key = req.headers["Idempotency-Key"]
    record = store.get_or_create(key, req)
    if record.state == "completed":
        return record.response

    # do the work
    node = pool.allocate(req.cpu, req.memory_gb)   # 1
    lease = leases.insert(node.id, req.principal)  # 2
    hypervisor.boot(node, req.image)               # 3

    response = make_response(node, lease)
    store.complete(key, response)
    return response
```

What happens when step 2 succeeds and step 3 fails because the hypervisor is briefly unreachable? The handler raises, the idempotency record stays `in_flight` (or worse, gets rolled back), the client retries, and now you have a leased node with no booted instance. The next retry allocates another node because `pool.allocate` is not idempotent.

The fix is to make every side effect inside the handler keyed by the same idempotency key, so retries converge:

```
allocation_id = stable_hash(key + ":alloc")
lease_id      = stable_hash(key + ":lease")
boot_id       = stable_hash(key + ":boot")
```

Then `pool.allocate` becomes "allocate or return existing allocation for this allocation_id," `leases.insert` becomes "insert or return existing lease," and `hypervisor.boot` becomes "boot or report current state for this boot_id." Each downstream system needs its own idempotency story, but you derive the keys rather than invent them.

On retry, your handler must check each sub-key's state before re-issuing. `pool.allocate` returns the existing allocation, `leases.insert` returns the existing lease, `hypervisor.boot` reports the current state. This is what makes the handler resumable, not just idempotent: a retry that arrives after step 2 succeeded but step 3 failed walks past steps 1 and 2 cheaply and only re-attempts the boot.

A concrete trace of a retry that lands between step 2 and step 3:

```
attempt 1 (key K):
  pool.allocate(H1) -> MISS -> allocate, store H1 -> node-42
  leases.insert(H2) -> MISS -> insert,   store H2 -> lease-99
  hypervisor.boot(H3) -> MISS -> RPC fails, nothing stored
  handler raises, in_flight row stays (or cleared by panic handler)

attempt 2 (same K):
  pool.allocate(H1) -> HIT  -> returns node-42 (no new alloc)
  leases.insert(H2) -> HIT  -> returns lease-99 (no new lease)
  hypervisor.boot(H3) -> MISS -> RPC retried, succeeds
  store.complete(K, response)
```

Only `hypervisor.boot` actually re-runs. The earlier side effects are free because their sub-keys already resolved.

If the hypervisor genuinely cannot accept a caller-supplied id (legacy thing, sorry), wrap it with a two-phase pattern. Do NOT hold a DB transaction open across the hypervisor call; it is the slowest thing in the path and a long-held lock will eat your connection pool. Insert a `pending` row keyed by `boot_id` before the call, commit, make the call, update the row with the `real_id`. On retry, you see the `pending` row, ask the hypervisor "what happened to the boot for `boot_id`," and either record the real id or treat the boot as needing a fresh attempt.

## What about the responses to nonidempotent verbs like DELETE and PATCH?

Same scheme, slightly different semantics. `DELETE /v1/workers/{id}` is idempotent at the resource level (first delete succeeds, subsequent deletes 404 or 204), but the *response* is not: the second caller sees a different status code than the first. If your client treats 404 as a failure that triggers a retry, you have a doom loop.

Wrap it in the same key scheme. Store the first response, return it on every retry within the window. The client always sees 204, even on the seventeenth retry. The resource was deleted exactly once.

```python
def delete_worker(req, worker_id):
    key = req.headers["Idempotency-Key"]
    record, inserted = store.claim(key, req)   # INSERT ... ON CONFLICT DO NOTHING RETURNING (xmax = 0)
    if not inserted:
        if record.state == "completed":
            return record.response             # always 204, even if row is gone
        return Response(status=409, headers={"Retry-After": "1"})

    workers.delete(worker_id)                  # 404 here is fine, treat as deleted
    response = Response(status=204)
    store.complete(key, response)
    return response
```

The second call inside the window never reaches `workers.delete`. It returns the stored 204 even though the underlying row is now gone, which is exactly what the client's retry loop wants to see.

`POST /v1/workers/{id}/reboot` is the spicy one. Reboot is not naturally idempotent: two calls cause two reboots, and on real hardware that can mean a stuck firmware update or a thermal trip. Idempotency keys are the only mechanism by which clients can retry it safely.

## Expiry, garbage collection, and storage

A few practical notes:

- The key store will grow. Pick an expiry, write a sweeper, do not let it become the largest table in your DB.
- The expiry window must cover the longest retry budget any client uses. 24h fits most APIs. For long-running provisioning where the client is a CI job that retries the next night, consider 7 days.
- After expiry the key is reusable. Usually fine because clients generate fresh keys per request. If paranoid, prefix keys with the day.
- Compress large response bodies. Provisioning responses with full node metadata multiply by retention window and request rate.
- Do not store 5xx responses. The whole point of 5xx is "try again." Caching a 503 forever is the wrong behavior. Store only terminal responses: 2xx, plus 4xx that you are confident represent a permanent client error.

That last point trips people up. The rule I use: cache the response if and only if the server has made a durable state change *or* has decided that no state change will ever happen for this request. A 400 "your image tag does not exist" is cacheable. A 503 "downstream is sad" is not.

A quick lookup table for the common cases:

| Response                                       | Cache it? | Reasoning                                                |
|------------------------------------------------|-----------|----------------------------------------------------------|
| 2xx terminal (200, 201, 204)                   | Yes       | Durable state change; retries must see the same answer.  |
| 400 (bad image tag, malformed body)            | Yes       | Permanent client error; the same request will fail forever. |
| 403 (auth/permission denied)                   | Yes       | Permanent for this principal + payload.                  |
| 422 (validation failed)                        | Yes       | Same as 400, the body is wrong on purpose.               |
| 404 on a DELETE wrapper (first response)       | Yes       | Resource was already gone, but the answer is stable.     |
| 408 (request timeout)                          | No        | Server never finished; retry is exactly the right move.  |
| 429 (rate limited)                             | No        | Retryable by definition.                                 |
| 5xx (500, 502, 503, 504)                       | No        | "Try again" is the contract; caching defeats it.         |

## What the client should do

Server-side discipline is half the story. The client contract:

- Generate the key once per logical operation, *before* the first attempt. Persist across retries. Persist across process restarts if the operation matters.
- Retry on network failures and 5xx with backoff. Do not generate a new key.
- On 409 with an idempotency mismatch, do not retry. The body changed, which is a bug. Surface it.
- On 2xx you are done, no matter how many retries it took.

Common antipattern: the client library generates a fresh UUID inside the retry loop. The author thought "UUIDs are unique, this is fine." It defeats the mechanism entirely. Audit your SDKs.

## Why infra teams skip this and what it costs

The usual excuses for not implementing this on a control plane:

1. "Our clients are well-behaved internal services." They are not, internal services run on flaky networks under load and retry as aggressively as you would expect.
2. "Our operations are fast enough that retries are not a problem." Provisioning takes seconds to minutes. The window for a retry that arrives after the original succeeded is enormous.
3. "We have eventual consistency, it sorts itself out." It does not, phantom resources sit there draining quota until someone files a ticket.
4. "We will add it later." The first attempt at the retrofit usually surfaces downstream systems that do not accept caller-supplied ids, and the cleanup becomes a multi-quarter project.

Build it in on day one. The wire format is six lines of middleware, the store is one table with three indices, the hard part is making handlers safe (which you should be doing anyway). If you remember nothing else: hash the body so `409 Conflict` catches the same-key-different-payload bug, store the response so retries inside the window are free, and key every downstream side effect off the same value so your handler is resumable rather than merely idempotent. The first time a client SDK ships an aggressive retry policy, the fleet will not double.
