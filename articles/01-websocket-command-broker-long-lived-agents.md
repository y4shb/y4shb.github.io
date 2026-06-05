# Designing a websocket command broker for long-lived agent connections

*why your fleet wants to phone home and stay on the line*

A few thousand test rigs sit across half a dozen labs. Each rig is a bare-metal machine doing something noisy: burning in firmware, running regressions, scraping kernel logs. A controller, which we will call `fleetlink`, needs to push commands to any of them within a second or two. "Reboot rig 0414." "Pull the last 500 lines of dmesg." "Start regression suite 7." Multiply by a thousand rigs and a busy human operator hammering the UI.

The naive answer is HTTP polling. Every rig wakes up every N seconds, hits `GET /fleetlink/commands?rig=0414`, and runs whatever comes back. This works for about a week. Then the math catches up to you.

## Why HTTP polling falls apart

The math is brutal. At a 5 second poll interval with 2000 rigs, you are eating 400 requests per second of pure overhead before anyone has actually done anything useful. Each request burns a TCP handshake (or at least a TLS resumption), a header round trip with cookies and auth tokens, and a database lookup to check whether a command exists for that rig.

Latency is awful too. A command issued at t=0 lands on the rig somewhere between t=0 and t=5 seconds, averaging 2.5s. Cut the interval to 1 second and you have 2000 RPS of mostly-empty responses and an exhausted load balancer.

You can fix latency with long-polling. Now every rig holds open a request for up to 30 seconds, the server parks it, and replies when a command shows up. Better latency, fewer requests, but you have invented websockets badly. You are paying for an HTTP request frame, a parked goroutine or thread, and a forced disconnect every 30 seconds, all to deliver a single command.

Lined up side by side, the three options look like this for a 2000-rig fleet:

| Transport | Avg command latency | Steady-state req/s | Per-connection overhead |
|---|---|---|---|
| Polling (5s) | ~2.5s | 400 | TCP+TLS handshake + headers per poll |
| Long-polling (30s park) | ~50ms when idle, request still recycled every 30s | ~67 + bursts on reconnect | Parked goroutine/thread per rig, request frame every 30s |
| WebSocket | ~5-20ms (network limited) | 0 in steady state | One open socket per rig, ping/pong every 20s |

The websocket row makes overhead vanish in steady state, at the cost of every problem in the rest of this post.

Commit to the persistent connection. Each rig opens one websocket to `fleetlink`, keeps it open for hours or days, and we push commands down it. The rest of this post is about everything that goes wrong when you actually try this.

## The shape of the broker

Here is the rough topology.

```
   rig-0001 ─┐
   rig-0002 ─┤     ┌──────────────┐     ┌──────────┐
   rig-0003 ─┼─ws──┤ fleetlink-fe ├─────┤ fleetlink│
     ...    ─┤     │   (broker)   │     │  control │
   rig-2000 ─┘     └──────────────┘     └──────────┘
                       │   ▲
                       ▼   │
                    ┌────────┐
                    │  redis │  (pub/sub + connection registry)
                    └────────┘
```

`fleetlink-fe` is the broker. It is a stateless-ish process whose only job is to terminate websocket connections from rigs and shuffle messages between them and the control plane. We run several instances behind a TCP load balancer. The connection registry in Redis is just a hash: `rig_id -> broker_instance_id`, so when control wants to talk to a specific rig it knows which broker to route through.

The broker does almost no business logic. It speaks one protocol to rigs (websocket frames carrying JSON or msgpack), one protocol to control (gRPC, internal pubsub, whatever you like), and translates between them. Keep it boring.

## Connection lifecycle

A new rig boots, reads its config, and dials `wss://fleetlink.example.internal/agent`. On connect, it sends a `HELLO` frame:

```json
{ "type": "hello", "rig_id": "rig-0414", "version": "agent-2.7.3", "boot_id": "b7a1...e9" }
```

The `boot_id` is a fresh UUID per process start. This matters later for reconnects. The broker validates the rig's mTLS cert, looks up its identity, and either accepts with a `WELCOME` or closes with a reason code.

On `WELCOME`, the broker writes `rig-0414 -> broker-fe-03` into Redis with a short TTL (say 60 seconds) and starts refreshing it. Now the control plane can find rig 0414.

The unhappy branches are worth pinning down here so the later sections have something to refer back to:

- **Malformed `HELLO`** (missing fields, bad JSON, unknown protocol version): close with code 4400, log the cert subject, no Redis write. Do not attempt a partial registration.
- **`rig_id` collides with an active healthy connection** (current entry's `boot_id` matches and the owning broker is still pinging): close the new connection with code 4409 and let the rig retry after backoff. This protects against a rig that has cloned its config to a second machine.
- **`rig_id` collides with a stale entry** (different `boot_id`, or owner has not refreshed): take ownership via the Lua script later in the post. This is the normal reconnect path.

Two things make the rest of this lifecycle harder than it looks: the connection can die without telling anyone, and the rig can reconnect to a different broker instance before the old entry has expired. We will deal with both.

## Ping, pong, and the half-open socket

Half-open TCP (the rig vanishes but the broker's socket stays in `ESTABLISHED`) is the failure mode that bites everyone exactly once. The general diagnosis of dead tunnels gets its own post later in the series; here I'll focus on the websocket-frame piece.

Websocket has dedicated `PING` (opcode 0x9) and `PONG` (opcode 0xA) control frames defined in RFC 6455 sections 5.5.2 and 5.5.3 (https://www.rfc-editor.org/rfc/rfc6455.html), payload capped at 125 bytes. The broker sends a `PING` every 20 seconds and expects a `PONG` within 10. Three misses and the connection is forcibly closed.

```python
async def keepalive(conn):
    while True:
        await asyncio.sleep(20)
        pong_ok = False
        try:
            pong_waiter = await conn.ping()
            await asyncio.wait_for(pong_waiter, timeout=10)
            pong_ok = True
        except (asyncio.TimeoutError, websockets.ConnectionClosed, OSError):
            # Treat any ping failure as a missed pong. A ConnectionClosed
            # here means the socket is already gone, which is exactly the
            # state the miss counter is meant to detect.
            pass

        if pong_ok:
            conn.missed_pings = 0
        else:
            conn.missed_pings += 1
            if conn.missed_pings >= 3:
                await conn.close(code=4002, reason="ping timeout")
                return
```

`conn.ping()` returns a future that resolves when the matching `PONG` arrives; `wait_for` raises `TimeoutError` on silence. I'm being explicit with `pong_ok` instead of relying on `try/except/else` so the success path is obvious at a glance.

Do not rely on the rig pinging the broker. Some flaky NAT in front of the rig may happily forward outgoing PINGs while dropping incoming traffic. The broker pings, the rig must pong, and silence is treated as death.

## Proxy idle timeouts (the broker owns this number)

If you put anything between rigs and the broker (load balancer, reverse proxy, cloud LB), you inherit its idle timeout, and that number drives every other liveness decision in your stack. The defaults worth memorizing:

| Proxy | Default idle | Tunable? | Source |
|---|---|---|---|
| AWS NLB (TCP listener) | 350s | Yes, 60-6000s since Sept 2024 | [NLB configurable idle timeout](https://aws.amazon.com/blogs/networking-and-content-delivery/introducing-nlb-tcp-configurable-idle-timeout/) |
| AWS NLB (TLS listener) | 350s | No, fixed | same |
| AWS ALB | 60s | Yes, 1-4000s | [ALB attributes docs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html) |
| nginx `proxy_read_timeout` | 60s | Yes, per-directive (inter-read, not total) | [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) |
| Azure Front Door (websocket) | 300s, plus 4h max connection lifetime | No | [Front Door websocket docs](https://learn.microsoft.com/en-us/azure/frontdoor/standard-premium/websocket) |
| Cloudflare Free/Pro (websocket) | 100s | Enterprise only | [Cloudflare websockets docs](https://developers.cloudflare.com/network/websockets/) |
| Most corporate squid/forward proxies | 60s, sometimes 30s | Depends on the team that owns it | local config |

Two AWS quirks worth knowing. ALB resets idle on the last byte in either direction, so a broker ping is enough to keep the whole connection alive. NLB's cross-zone setting does not change the timeout but does change whether your keepalive traffic shows up as cross-AZ on the bill.

If your ping interval is longer than the smallest idle timeout on the path, connections die in lockstep every minute or so, and you will spend three days wondering why. The rule: ping interval strictly less than the tightest proxy idle on the path, with comfortable margin. 20s pings comfortably survive a 60s proxy. Verify by actually tracing one connection through every hop and asking each ops team what their timeouts are. Do not trust documentation; read the running config.

(One related nginx footgun while we are here: nginx caps a single request-header field at one `large_client_header_buffer`, default 8 KB, with up to 4 such buffers, see nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers. `client_header_buffer_size` defaults to 1 KB and applies to the initial read. If your `HELLO` upgrade request carries a fat JWT, you will hit one of these before you ever reach the websocket handler.)

(Other posts in this series will mention proxy idle behavior in passing; the numbers above are the canonical reference.)

## Ordered command delivery

Once a connection is up, what does it carry? Commands from control, plus responses and unsolicited events from the rig. Two design choices have outsized impact: ordering and acknowledgement.

For a single rig, commands should be delivered in the order control issued them. If an operator clicks "stop regression" then "reboot", you really do not want those reversed.

The simplest way to get this is to give each rig a single per-connection outbound queue, and one writer goroutine that drains it. No fan-out, no parallel sends. Within one connection, websocket is ordered (it is TCP), so as long as the broker writes in order, the rig receives in order.

```go
type RigConn struct {
    id      string
    outbox  chan Command   // buffered, e.g. 128 deep
    ws      *websocket.Conn
}

// Called by the control plane when it issues a command. The seq is
// assigned here, NOT in the writer, so retries and replays preserve
// the original number.
func (r *RigConn) Enqueue(cmd Command) error {
    cmd.SeqNo = r.nextSeq()
    select {
    case r.outbox <- cmd:
        return nil
    default:
        return ErrOutboxFull
    }
}

func (r *RigConn) writer(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case cmd := <-r.outbox:
            if err := r.ws.WriteJSON(cmd); err != nil {
                r.fail(err)
                return
            }
        }
    }
}
```

Each command gets a monotonic `seq_no` at enqueue time. The rig sends back an `ACK` with that seq when it has accepted (not necessarily completed) the command. The seq is a per-(rig, current connection attempt) routing token, not a log-stream offset; replay across reconnects is its own design problem and I cover it in a later post.

## Backpressure when one rig stalls

Here is the subtle one. A rig stops reading. Maybe its agent is wedged in a syscall, maybe a disk is full and logging is blocking, maybe someone is single-stepping it in gdb. Its TCP receive window fills up. The broker's `WriteJSON` call blocks. If your writer goroutine is shared, every other rig grinds to a halt. If you have one writer per rig (as above), only this rig is stuck, but the outbox channel fills up, and now control attempts to enqueue commands and blocks too.

You have a few choices. None of them are perfect.

1. **Bounded outbox, drop oldest.** When the outbox is full, drop the oldest queued command. Cheap, but you silently lose commands.
2. **Bounded outbox, drop newest with error.** New enqueue returns an error to control. Control surfaces the failure to the operator. Annoying but honest.
3. **Bounded outbox, kill the connection.** If the outbox fills, declare the rig dead, close the socket, let it reconnect. Brutal but predictable.

For an interactive operator UI, option 2 is usually right: tell the human the rig is unresponsive, let them decide. The shape of that "honest error" in the operator UI is what makes the choice concrete. Control surfaces it as the response to the enqueue RPC, and the UI renders it next to the rig row:

```json
{
  "error": "rig_unresponsive",
  "rig_id": "rig-0414",
  "detail": "outbox full (128/128), oldest queued cmd age 47s",
  "last_ack_seq": 8421,
  "last_ack_at": "2026-04-12T14:03:11Z",
  "suggested_action": "force_reconnect"
}
```

The operator sees "rig-0414: unresponsive, last ack 47s ago, [Force reconnect]" and the button is just option 3 wrapped in human consent. Automated control loops with idempotent commands skip the human and go straight to option 3.

The bug to avoid: an unbounded outbox. Don't. Memory growth on a stuck rig in a fleet of thousands turns into an OOM in the broker, and now every connection drops at once. Which brings us to the next horror.

## Reconnect storms

The broker dies. Or restarts for a deploy. Or the LB shuffles connections. Two thousand rigs all notice within a second and reconnect simultaneously. If your broker startup involves any per-connection work that touches a shared resource (a database, a registry, an auth service), you will overload it instantly.

Mitigations, roughly in order of importance.

**Jittered reconnect on the rig side.** This is the change with the biggest payoff. The math:

```python
def reconnect_delay(attempt):
    base = min(2 ** attempt, 30)        # cap at 30s
    return random.uniform(0.5, 1.5) * base
```

A few things worth noting about that formula:

- Spelled out: `attempt=0` → base 1s, `attempt=1` → 2s, `attempt=2` → 4s, `attempt=3` → 8s, `attempt=4` → 16s, `attempt=5` → 32s capped at 30s, then 30s forever. Capping prevents the rig from waiting an hour after the broker has been back up for fifty minutes.
- `random.uniform(0.5, 1.5) * base` is "full jitter centered on the base", which I prefer over the half-jitter variant (`base/2 + random*base/2`). It smears the reconnect window symmetrically and is easy to reason about.
- The first attempt (`attempt = 0`) gives a delay between 0.5 and 1.5 seconds. Some teams want `attempt = 0` to mean "try immediately"; resist that urge during a reconnect storm, because it means a thousand rigs all retry at once before any backoff has kicked in.

Without jitter, every rig that disconnected at the same instant reconnects at the same instant. With jitter, they smear across a window. If you remember one thing from this whole post, remember the `random.uniform`.

**Connection-rate limiting at the broker.** Accept new connections at a bounded rate per broker instance. Excess connections get a `503` or websocket close with a backoff hint, and the rig waits longer. This is uncomfortable to design (you are intentionally rejecting clients) but it protects the broker from death-spiraling. A token-bucket on the Accept loop is enough:

```go
// 50 new conns/sec, burst 100.
var acceptBucket = rate.NewLimiter(rate.Limit(50), 100)

func acceptLoop(ln net.Listener) {
    for {
        raw, err := ln.Accept()
        if err != nil { return }

        if !acceptBucket.Allow() {
            // WebSocket close code 4503 is app-defined; the rig agent
            // reads the reason for a Retry-After-style hint in seconds.
            backoff := 5 + rand.Intn(10) // 5-15s, jittered
            rejectWithCloseFrame(raw, 4503, fmt.Sprintf("retry_after=%d", backoff))
            continue
        }

        go handleConn(raw)
    }
}
```

Close codes 4000-4999 are the private-use range, so 4503 mirrors HTTP 503 semantics without conflicting with reserved codes. The reason field is plain UTF-8 (max 123 bytes after the 2-byte code), enough for a `retry_after=<seconds>` hint the rig parses before its next attempt.

**Stateless authentication.** If you authenticate by hitting an auth service per connection, that service will fall over during a reconnect storm. Use JWTs or pre-shared mTLS certs that the broker can validate locally with a cached CA bundle. Hit the auth service only for revocation checks, asynchronously, and tolerate the lag.

**Warmup the broker before the LB sends traffic.** When a broker starts, give it 5 seconds before it advertises itself as healthy. This lets caches populate and prevents the LB from shoving 500 reconnects at a cold process.

## Reconnects that race with their own ghost

A rig drops, reconnects in 1.2 seconds to a different broker instance. The Redis entry `rig-0414 -> broker_fe_03` from the previous connection still exists with TTL 58s. The new broker `broker_fe_07` writes `rig-0414 -> broker_fe_07` and starts refreshing. So far so good.

Now control wants to talk to rig 0414. It reads Redis. Whichever broker wrote last wins. But `broker_fe_03` is still alive and still firing its own refresh timer because it hasn't yet noticed its socket is dead, and if its refresh lands after `broker_fe_07`'s write, control routes to a broker holding a corpse.

The fix is a single Lua script that makes every write conditional on the `boot_id`. Store the registry value as the tuple `(boot_id, broker_id)`, with `boot_id` written as the canonical 36-char hyphenated hex form so Redis lexical compare matches UUIDv7 time order (pass raw 16-byte binary and the compare goes sideways). Then:

```lua
-- KEYS[1] = "rig:0414"
-- ARGV[1] = my_boot_id
-- ARGV[2] = my_broker_id
-- ARGV[3] = ttl_seconds
-- ARGV[4] = "hello" or "refresh"
local existing = redis.call("GET", KEYS[1])
local new_val  = ARGV[1] .. "|" .. ARGV[2]

if existing == false then
  redis.call("SET", KEYS[1], new_val, "EX", ARGV[3])
  return "ok"
end

local cur_boot, cur_broker = string.match(existing, "([^|]+)|([^|]+)")

if ARGV[4] == "hello" then
  -- New HELLO always wins if its boot_id is strictly newer.
  -- boot_ids are time-ordered UUIDv7s, so lexical compare is fine.
  if ARGV[1] > cur_boot then
    redis.call("SET", KEYS[1], new_val, "EX", ARGV[3])
    return "ok"
  end
  return "stale_hello"
end

-- "refresh" path: only the writer that owns the tuple may extend it.
if cur_boot == ARGV[1] and cur_broker == ARGV[2] then
  redis.call("EXPIRE", KEYS[1], ARGV[3])
  return "ok"
end
return "superseded"
```

Walking through the race as a timeline:

```mermaid
sequenceDiagram
    participant rig as rig-0414
    participant fe03 as broker_fe_03
    participant redis as redis
    participant fe07 as broker_fe_07

    Note over rig,fe07: t=0  boot B1, connect
    rig->>fe03: HELLO(B1)
    fe03->>redis: SET (B1, fe_03)
    Note over redis: state = (B1, fe_03)

    Note over rig,fe07: t=10  refresh tick
    fe03->>redis: refresh(B1, fe_03)
    redis-->>fe03: ok

    Note over rig,fe03: t=12  socket drops (fe_03 has not noticed)

    Note over rig,fe07: t=13.2  rig boots B2, lands on fe_07
    rig->>fe07: HELLO(B2)
    fe07->>redis: SET (B2, fe_07)
    Note over redis: state = (B2, fe_07)

    Note over rig,fe07: t=14  ghost refresh from fe_03
    fe03->>redis: refresh(B1, fe_03)
    redis-->>fe03: superseded
    Note over fe03: tear down ghost socket

    Note over rig,fe07: t=20  legitimate refresh
    fe07->>redis: refresh(B2, fe_07)
    redis-->>fe07: ok
```

The key step is t=14. Without the Lua check, `broker_fe_03`'s refresh would blindly `SET` the registry back to `(B1, fe_03)` and control would route commands to a broker holding a corpse for up to one TTL. With the check, the script reads the current tuple, sees the mismatch, returns `superseded`, and the old broker tears down its dead socket.

Two brokers can never both think they own a rig past the next refresh tick, which is the actual guarantee you need. UUIDv7 makes the `boot_id` compare safe: it puts a 48-bit Unix-ms timestamp in the high bits (RFC 9562), so byte-wise compare orders IDs by creation time across milliseconds. Intra-ms ordering depends on the generator method in section 6.2, which does not matter here because two reconnects in the same millisecond do not happen in practice.

## Things I have not covered but you will hit

A short list, because this post is already long enough.

- **Message size limits.** Some clients send 10MB log dumps over the command channel. Don't let them. Separate channel, separate limits, or a presigned-URL upload to object storage with just a notification over the websocket.
- **Per-rig fairness.** One chatty rig can monopolize a broker's CPU. Token-bucket per connection.
- **Observability.** Metrics per connection are expensive at 2000 connections. Aggregate by rig group, not per rig, and sample slow paths.
- **Graceful broker shutdown.** Send a `GOAWAY` frame, give rigs 10 seconds to reconnect elsewhere, then close. This avoids the entire fleet noticing at the same millisecond.
- **Schema evolution.** Your protocol will change. Version every message. Tolerate unknown fields. Refuse unknown message types loudly during development, silently in production.

The pattern underneath all of this is the same. A persistent connection is a stateful object pretending to be a transport. Treat liveness, ordering, backpressure, and identity across reconnects as design decisions, not surprises. Write them down.
