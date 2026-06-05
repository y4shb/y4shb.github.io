# Designing audit logs that survive a hostile insider review

*append-only is not the same as tamper-evident, and your SRE knows where the log volume is mounted*

The fiction every audit log tells is that writing `event_type=permission.grant` to a file called `audit.log` constitutes evidence. It does not. It constitutes a string in a file that anyone with root on the host, write access to the log bucket, or a cooperative DBA can edit, truncate, or quietly delete a single line from with `sed -i`. When the question nine months later is "did Priya actually grant herself prod-write at 03:14 on a Saturday, or did someone else do it from her session," a plain text log answers neither half.

This post is about building audit logs that hold up when the threat model includes someone on your own team. Not the cartoon insider with a hoodie. The much more common case: a senior engineer with legitimate prod access, a deadline, and a reason to make a thing they did look like a thing the system did. The defenses are not exotic. They are mostly about removing the assumption of trust from places it snuck in.

## What an audit log actually has to answer

Forget the schema for a minute. The auditor sitting in a conference room nine months after the incident has four questions, in this order:

1. **Who did this.** Not which service account. Which human, via which session, from which device.
2. **What changed, exactly.** Before-value and after-value, not a verb.
3. **What else happened in the same causal chain.** If `role.assigned` fires, what API call triggered it, what session opened that call, what auth event opened that session.
4. **Can I trust these records.** If the answer to this is "well, we have backups," you have already lost the audit.

A surprising number of "audit systems" answer (1) with a service principal, (2) with an event name and no diff, (3) with nothing because there is no correlation ID, and (4) with a shrug. You can ship an entire SIEM and still miss all four.

## Actor versus subject: stop conflating them

The single most common schema mistake is one `user_id` field. Consider a permission change in a multi-tenant system:

- A platform engineer named Marcus, logged into the admin console via SSO session `sess_8af2`, calls an endpoint that grants the `billing.read` role to user `u_991` in tenant `t_acme`, acting on a support ticket filed by `u_991` themselves.

That event has four distinct identities:

| Field | Value | Meaning |
|-------|-------|---------|
| `actor.principal` | `marcus@example.com` | The human who initiated |
| `actor.session_id` | `sess_8af2` | The auth context they used |
| `actor.on_behalf_of` | `u_991` | Delegated authority, if any |
| `subject.principal` | `u_991` | The entity changed |
| `subject.tenant` | `t_acme` | Scope of the change |

Now suppose six months later Marcus claims his account was compromised. With a single `user_id` field you cannot distinguish "Marcus did it" from "something acting as Marcus did it." With `actor.session_id` you can join to the auth log and see the IP, the device fingerprint, the MFA method, and whether the session predates the alleged compromise. Without it you are guessing.

The same separation matters for service-to-service calls. The actor is the service account; the `on_behalf_of` is the end user whose request triggered the chain. Auditors care about the latter. Ops cares about the former. Store both.

## The hash chain, done correctly

Append-only buys you nothing if your insider has shell access. The standard fix is a hash chain: each entry carries a hash of the previous entry, so deleting or modifying any record breaks every record after it. The concept goes back to Bellare-Yee (1997) and Schneier-Kelsey (1999), well over two decades old, and implementations are still routinely wrong (https://www.schneier.com/wp-content/uploads/2016/02/paper-auditlogs.pdf).

A minimal correct entry:

```python
import hashlib
import json
from datetime import datetime, timezone

def make_entry(prev_hash: str, payload: dict, signing_key) -> dict:
    entry = {
        "seq": payload["seq"],
        "ts": datetime.now(timezone.utc).isoformat(),
        "prev_hash": prev_hash,
        "payload": payload,
    }
    # Canonical serialization is the whole game here.
    # json.dumps(sort_keys=True, separators=(",",":")) is deterministic within
    # Python, but it differs from RFC 8785 JCS on float formatting and Unicode
    # escaping, so for cross-language verifiers use a JCS library
    # (https://www.rfc-editor.org/rfc/rfc8785.html).
    canonical = json.dumps(entry, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).digest()
    entry_hash = digest.hex()
    entry["entry_hash"] = entry_hash
    # Sign the raw hash bytes, not the hex string, so verifiers in other
    # languages do not have to know about the encoding dance.
    entry["signature"] = signing_key.sign(digest).hex()
    return entry
```

Three things that look like nitpicks but are not:

**Canonical serialization.** If two writers produce the same logical entry but one has `{"a":1,"b":2}` and the other has `{"b": 2, "a": 1}`, their hashes differ. Pick canonical JSON or CBOR and enforce it in one library that everyone uses. Do not let each service hand-roll its own serialization.

**Sign the hash, not the payload.** The hash is fixed-size and cheap to sign. The signature proves the entry existed at write time; the chain proves nothing in front of it has moved. The next entry's `prev_hash` is set to this entry's `entry_hash` (the signature is metadata, not part of the chain link), so a verifier only needs the hashes to walk the chain.

**The signing key does not live on the box that writes logs.** If the same host that calls `make_entry` also holds the private key, an attacker with root on that host can forge entries indefinitely. The write path should send to a dedicated signer (HSM, KMS, or a small isolated service whose only job is "sign this hash"). Yes, this introduces latency. Yes, you should do it anyway for security-sensitive events. For high-volume non-security events, batch and sign roots of Merkle trees instead.

## Write-only sinks: the unsexy half

The chain proves tampering. It does not prevent it. For prevention you need a sink that the writer cannot delete from. Concrete options, ranked by how much your insider has to defeat:

```
weakest                                                strongest
   |                                                        |
   v                                                        v
[ local file ] -> [ central log host ] -> [ object store    ] -> [ append-only
   root can       compromise the         with object lock      log service in
   sed -i         central host           and bucket policy     a second AWS
                                         denying delete         account ]
```

The "second account" pattern is underrated. If your primary infra runs in account `prod-12345`, create `audit-99887` with its own IAM, its own break-glass, and a one-way pipe: prod can write, prod cannot read or delete, and only a two-person quorum from a security team can touch the bucket. An insider with full root on prod still cannot reach back and edit yesterday's entries. This is also where you put the public verification keys, so the prod host that signs entries cannot rotate the key that verifies them.

S3 Object Lock in compliance mode gives you the bucket-level half of this: neither the bucket owner nor the AWS root user can shorten retention or delete a locked object version before expiry. The cross-account isolation gives you the IAM half.

## Correlation IDs, or: how to find the one useful event

Here is the running example. Six months ago, customer `t_acme` claims an internal user saw their billing data without permission. You have three services involved: `gateway`, `identity`, and `billing-api`. Each writes its own audit stream. Total event volume across the three: 4.2 billion entries for the window in question.

Without a correlation ID, you are searching across three log stores for events involving `t_acme` and hoping the timestamps line up close enough to reconstruct a causal chain. They won't. NTP drift, batch flushes, and clock-skew on a misbehaving node will give you events that look out of order. You will spend two days writing join queries and produce a report that says "probably."

With a correlation ID propagated from the gateway through every downstream call, the query is one line: `correlation_id = "req_4f8a2c"`. You get back something like:

```
seq=88412901  ts=2025-11-14T03:14:02Z  svc=gateway
  event=auth.session.resumed  actor.session=sess_8af2
  correlation_id=req_4f8a2c

seq=88412903  ts=2025-11-14T03:14:02Z  svc=gateway
  event=http.request  method=POST path=/admin/roles
  actor.principal=marcus@example.com correlation_id=req_4f8a2c

seq=88412908  ts=2025-11-14T03:14:02Z  svc=identity
  event=role.assigned  subject.principal=u_991
  subject.tenant=t_acme role=billing.read
  actor.principal=marcus@example.com correlation_id=req_4f8a2c
  prev_hash=9c81...  entry_hash=b40e...

seq=88412940  ts=2025-11-14T03:14:18Z  svc=billing-api
  event=invoice.viewed  actor.principal=u_991
  subject.tenant=t_acme correlation_id=req_4f8a2c
```

That is the entire timeline, and it took 200ms to retrieve. The `prev_hash` on the `role.assigned` entry is verifiable against the previous entry in the identity service's chain, which means if Marcus tries to claim "that role grant never happened, your logs are wrong," you can hand the auditor the seventeen subsequent entries that all chain back through that one and ask them which of those eighteen records he would like to also dispute.

The correlation ID does the linking. The chain does the proving. You need both.

## Fields auditors actually ask for

After a few of these reviews you notice the same fields keep being the ones that are missing. A pragmatic minimum schema, beyond the actor/subject split above:

| Field | Why it matters | Common mistake |
|-------|---------------|----------------|
| `correlation_id` | Reconstruct causal chains across services | Generated per-service instead of propagated |
| `request_id` | Distinct from correlation; one per HTTP call | Conflated with correlation_id |
| `actor.auth_method` | "Was this a password, MFA, API key, or SSO?" | Logged as boolean `authenticated=true` |
| `actor.source_ip` | Geo and ASN, when account is later disputed | NAT'd to the load balancer IP |
| `actor.device_fingerprint` | Distinguishes "same user, same laptop" vs "same user, new device" | Not collected at all |
| `change.before` / `change.after` | The whole point of an audit log | Only `event_type` is stored |
| `change.reason` | Free-text justification, required at write time | Optional, therefore empty |
| `policy_version` | Which version of the rules was evaluated | Implicit, therefore unknowable later |

The `change.reason` field is the one that always gets debated. Engineers hate being forced to type a justification when they're firefighting. Auditors love it because it converts "this looks suspicious" into "this looks suspicious AND the reason field says 'fixing prod' with no ticket link." Make it required for any privileged action and let the bypass be a separate logged event ("reason field skipped, break-glass invoked").

The `policy_version` field looks academic until the day someone asks "was this action allowed under the policy that was in force at the time?" If your policy engine is rev'd weekly and you only log the decision, you cannot answer that. Log the version, log the input, log the output. Storage is cheap.

## The verifier nobody writes

You have a chain. Who actually verifies it?

If the answer is "we'd run a script if there was an incident," you have a chain that has never been verified, which means you do not know whether it is intact. The verification job should run continuously, on a host that is not the one writing logs, reading from the write-only sink, and alerting loudly when:

- An entry's `prev_hash` does not match the previous entry's `entry_hash`.
- An entry's signature does not verify against the published public key.
- Sequence numbers skip.
- Two entries claim the same sequence number.
- The chain stops advancing for longer than expected (insider stopped writing, not just stopped doing things).

That last one is the subtle one. An attacker who cannot edit history can still stop writing while they do their work. Liveness alerts (entry rate dropped to zero on a service that should be active) catch the gap. Pair them with a heartbeat event from each writer every N seconds so you can distinguish "service is idle" from "service stopped logging."

## What to leave out

A few common additions that look like security and are not:

- **Encrypting audit logs at rest with a key the same insider can read.** This protects against the laptop-in-a-bar threat, not the privileged insider threat. Useful for compliance checkboxes, useless for your actual threat model.
- **PII in audit events.** You will end up legally obligated to delete entries that customers request, which breaks your chain. Reference PII by stable opaque IDs; keep the PII in a separately governed store that supports per-record deletion. Hash chains and GDPR right-to-erasure are fundamentally incompatible; design around it. A common pattern is crypto-shredding: encrypt subject references with per-subject keys and delete the key on erasure, which leaves the chain intact while making the PII unrecoverable.
- **Audit logs as the primary analytics source.** Once people start running dashboards off audit data, every schema change becomes a six-team negotiation, and someone will propose "let's just denormalize this one field." Audit logs are evidence, not telemetry. Keep them boring.

## The smaller point

Most of what makes an audit log survive hostile review is not cryptography. It is the discipline of separating the actor from the subject, propagating one ID end-to-end, signing entries somewhere the writer cannot reach, and writing them somewhere the writer cannot delete from. The hash chain is the bow on top: it converts a suspicion of tampering into a mathematical claim, which is what an auditor actually wants to see in a report.

The thing to internalize is that the design audience is not your future self trying to debug a thing. It is a stranger nine months from now, sitting across a table from your CISO, holding a printout of one event and asking "how do you know this is real." Build for that conversation. The dashboards will work out.
