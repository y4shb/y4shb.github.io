# Reverse-tunnel agents for hosts you cannot reach

*patterns for boxes you cannot SSH into directly*

You ship a customer appliance. It sits in their datacenter, behind their firewall, on a VLAN that drops inbound TCP on the floor. Your support contract says you will push firmware updates and pull diagnostic logs on demand. You cannot SSH in. You cannot port-forward to it. The customer's security team will not poke a hole for you, and you do not want them to.

What you can do is have the appliance dial out:

```bash
ssh -N -R 2200:localhost:22 tunnel@relay.example.net
```

That one line is the seed of the whole pattern. The appliance opens an outbound SSH connection to a relay you own, and asks the relay to forward port 2200 back down the channel. From now on, anyone who can reach the relay can SSH into the appliance through port 2200. Inbound from the customer's perspective is still firmly blocked; from yours, the appliance might as well have a public IP.

The interesting part is everything that happens after you scale it past five machines and try to keep it alive for months.

## The basic shape

You have three roles:

```
   +-----------+        +-----------+        +-----------+
   |  client   |        |  relay    |        |   agent   |
   |  (you)    | -----> |  (you)    | <----- |  (them)   |
   +-----------+        +-----------+        +-----------+
                         port 2200             behind NAT
```

The **agent** is the unreachable box. It runs something like:

```bash
ssh -N -R 2200:localhost:22 tunnel@relay.example.net
```

The `-R 2200:localhost:22` tells the relay: "open port 2200 on yourself, and any TCP connection that lands there, send it back down this SSH channel to my local port 22." Now from the relay, you can do `ssh -p 2200 root@localhost` and you are talking to the agent.

The **relay** is a small VM you own that has a public IP and accepts SSH on 22 from anywhere you allow. It does not run anything special. It is just a TCP rendezvous point with a stable address. Treat it as cattle, not pets. Sizing is modest: an idle sshd is roughly 5 to 8 MB RSS, so a 512 MB VM comfortably holds a few thousand idle tunnels with headroom for the kernel and your supervisor. CPU is a non-issue until you start running heavy traffic through the channels.

The **client** is your CI runner, your laptop, or any system that wants to push commands to the agent. It SSHes into the relay, then either chains another SSH from there, or uses `ProxyJump`:

```bash
ssh -J tunnel@relay.example.net -p 2200 root@localhost
```

That is the basic pattern. Everything else is what running it in production teaches you.

## Managing the connection from the wrong side

The first non-obvious thing: the agent is the only party that can establish the tunnel. The relay cannot dial out and create one. So whatever process manages the tunnel must live on the unreachable side, which means you cannot just push it a new config and bounce it. You have to design it to recover from its own mistakes.

A systemd unit on the agent is the lightest reasonable thing that works:

```ini
[Unit]
Description=Reverse tunnel to relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -R 2200:localhost:22 \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new \
    -i /etc/tunnel/id_ed25519 \
    tunnel@relay.example.net
Restart=always
RestartSec=10
User=tunnel

[Install]
WantedBy=multi-user.target
```

Two SSH-specific gotchas that the generic "let the supervisor restart it" advice does not cover:

`ExitOnForwardFailure=yes` matters here. When the SSH process dies uncleanly, the previous remote forward can linger on the relay for tens of seconds because the relay's sshd has not yet noticed the parent connection is gone. When the agent reconnects, the `-R 2200` bind fails silently and SSH cheerfully holds open a tunnel with no remote forward attached. `ExitOnForwardFailure=yes` makes SSH treat that as fatal and exit, so the supervisor restarts it instead of leaving you with a zombie tunnel that "is up" but unreachable. Without this option, you will spend an afternoon debugging. One caveat worth knowing: this option only fires when the bind itself fails. It does not catch PermitOpen denials, downstream TCP failures, or a network that simply stops carrying packets (see `ssh_config(5)`).

The second gotcha is that the relay's sshd needs `ClientAliveInterval` / `ClientAliveCountMax` set, or it will hold those zombie bound ports until Linux's default TCP keepalive kicks in, which is 7200 seconds, two hours (`tcp_keepalive_time`, see `man 7 tcp`). Set it to 30 / 3 to match the agent side, so both ends agree on how long a missing keepalive means dead. The agent-side `ServerAliveInterval` / `ServerAliveCountMax` follow the same math: detection window is roughly `interval * count`, so 30 * 3 gives you about 90 seconds.

`autossh` is fine if you like belt-and-suspenders, but with `ExitOnForwardFailure` plus a sane supervisor, it does not add much.

## The port allocation problem

If every agent forwards to port 2200, you can have exactly one agent. The fix is per-agent ports. The fix to the fix is to not hand-maintain a port map across a thousand machines.

The pattern I have seen work: have each agent register itself at the relay on startup, get back a port, and then dial the tunnel with that port. Something like:

```
agent  -- HTTPS --> registry.example.net:443
       <-- {port: 12047, expires: ...}
agent  -- SSH -R 12047:localhost:22 --> relay.example.net
```

The registry is a tiny service (a single Go binary, or a Lambda, whatever) that owns the port map. It keys ports by a stable agent ID, which is some hash of the machine's hardware identifier or a UUID you bake in at provision time. When the agent dies and comes back, it gets the same port. When a new agent registers, it gets the next free one.

A registry response is mostly boring:

```json
{
  "agent_id": "bench-17",
  "relay_host": "relay.example.net",
  "relay_port": 12047,
  "health_port": 12048,
  "cert_expires_at": "2026-06-10T00:00:00Z",
  "last_seen_at": "2026-06-03T11:42:08Z"
}
```

Encode that port into DNS if you can. `bench-17.tunnels.example.net` resolving to a TXT or SRV record with the port is much easier to use from CI than a JSON lookup. Stock OpenSSH does not consume SRV records on its own (tracked upstream as Bugzilla 2217 for over a decade); you will need a wrapper that resolves the record and rewrites the host:port before invoking `ssh`. The "wrapper" can be ten lines:

```bash
#!/usr/bin/env bash
# usage: tssh bench-17 [extra ssh args...]
set -euo pipefail
host="$1"; shift
srv=$(dig +short SRV "_ssh._tcp.${host}.tunnels.example.net" | head -n1)
# SRV record: "<prio> <weight> <port> <target>."
# target = relay hostname, port = the per-agent forwarded port on the relay
port=$(awk '{print $3}' <<<"$srv")
relay=$(awk '{sub(/\.$/,"",$4); print $4}' <<<"$srv")
exec ssh -J "tunnel@${relay}" -p "$port" root@localhost "$@"
```

TXT and SRV in DNS here are for your tooling to consume, not for SSH itself.

## Key rotation without bricking the fleet

Here is the trap: the agent uses an SSH key to authenticate to the relay. That key sits on the agent. If you rotate the relay's `authorized_keys` and forget to update an agent, that agent is now permanently unreachable, because the only way you had to reach it was the tunnel you just broke.

Two rules.

First, **always overlap**. New key gets added to `authorized_keys` before old key gets removed. Schedule the removal at least a full deployment cycle later. If you have agents that come online once a week (lab benches that get powered off on weekends, for example), the overlap window is at least two weeks.

Second, **use certificates, not raw keys**. Generate an SSH CA, sign agent keys with it, and configure the relay's sshd with `TrustedUserCAKeys`. This is not a new toy: OpenSSH grew certificate-authority support in 5.4, released March 2010, so nearly every supported distro has it (ancient enterprise builds on pre-5.4 OpenSSH are the exception). Now rotating means signing a new cert and pushing it; the relay never needs to learn about individual agents at all. Certs can be short-lived (a week, a day) and the CA can revoke them.

```bash
# on the CA host
ssh-keygen -s ca_key -I "agent-bench-17" -n tunnel \
    -V +1w agent_key.pub
```

The cert ends up next to the key on the agent, and SSH picks it up automatically. When it expires, the agent's next reconnect will fail until it fetches a new one, which should be a cron job pulling from the registry.

The agent needs to be able to fetch new certs even when its tunnel is broken. That is, the cert-renewal path must not depend on the tunnel being healthy, because the whole reason the tunnel might be broken is the cert. Bootstrap that channel separately, over HTTPS to the registry with a separate credential.

If your environment is locked down enough that the agent's *only* outbound is SSH to the relay (common in customer-appliance and air-gap-adjacent setups), you cannot bootstrap cert renewal over HTTPS at all. In that case, push fresh certs *through* the tunnel itself well before the existing cert expires, and overlap aggressively. A cert that lives a week, renewed every two days, gives you five days of slack to notice and recover before the agent locks itself out.

## Multiplexing many sessions over one tunnel

Opening a fresh TCP connection through the reverse tunnel for every command is fine for low volume. Once your CI starts running parallel jobs against the same agent, you want SSH's `ControlMaster`:

```
Host bench-*
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

With this set on the client side, the first `ssh` to a given agent opens a master connection. Subsequent `ssh`, `scp`, and `rsync` calls to the same agent reuse it, skipping the TCP handshake, the SSH handshake, and the key exchange. The difference for a thousand quick commands is roughly the difference between an afternoon and lunch. `ControlPersist 10m` keeps the master alive for ten minutes of idle time after the last session disconnects, so back-to-back jobs amortize the setup cost.

The shape on the wire:

```
without ControlMaster                with ControlMaster
---------------------                ------------------
ssh ----TCP+SSH+kex---> agent        ssh -----+
ssh ----TCP+SSH+kex---> agent        scp -----+----- one TCP, one kex
scp ----TCP+SSH+kex---> agent        rsync ---+----- N multiplexed
rsync --TCP+SSH+kex---> agent        ssh -----+      SSH channels
                                              v
                                          agent
```


On the relay, you can do the same trick: have your reverse tunnel itself use multiplexing so that all your CI traffic flows through one TCP connection from the agent. Combined with `ControlPersist`, this means a job that runs fifty commands ends up looking like one TCP session on the wire.

You do pay for this with head-of-line blocking. If one command pegs the channel with `scp` of a large log, other commands queue behind it. For most lab use this does not matter. For high-throughput pipelines, run two tunnels: one for control-plane RPC, one for bulk data transfer.

## Detecting dead tunnels (the part everyone gets wrong)

Here is the failure mode that has burned every team I have worked with. The tunnel looks healthy. The SSH process is running on the agent. `netstat` on the relay shows the connection established. You connect to port 12047 and the TCP handshake completes. Then nothing. The connection just hangs.

The general "connections lie to you about being healthy" story (half-open TCP, NAT timeouts, why kernel keepalives are not enough by default) is its own post; the short version is that the SSH process and the kernel socket can both believe everything is fine while the actual path between agent and relay is gone. For tunnels specifically, you need three layers of defense, and you want all of them.

```
                  agent                      relay                client
                +--------+                 +--------+           +--------+
   Layer 1 ---> | ssh    |<--keepalive---->| sshd   |           |        |
                | proc.  |  30s x 3 = 90s  | proc.  |           |        |
                +---+----+                 +---+----+           +--------+
                    |                          |   port 12048
   Layer 2 -----+   |   reverse SSH channel    |<------- GET /healthz ----+
        /healthz|   v                          v                          |
                +---+----+ 127.0.0.1:8080  +---+----+                +----+----+
                | health |<----------------|forward |<---------------|registry |
                | resp.  |                 | :12048 |                |  probe  |
                +---+----+                 +--------+                +----+----+
                    ^                                                     |
   Layer 3 --------(GET /tunnels/me, compare last_seen_at)-----HTTPS------+
                    |
                if stale: kill local ssh, let systemd restart
```


**Layer 1: SSH-level keepalives.** `ServerAliveInterval=30` plus `ServerAliveCountMax=3` from the systemd unit above means the SSH client sends a keepalive every 30 seconds and, after three missed responses, tears down the connection. That detection window is roughly 90 seconds. Add the systemd restart (`RestartSec=10`), the new SSH handshake, and re-registration with the registry, and end-to-end recovery is more like 90 to 120 seconds. The important point is what this layer does *not* catch: anything where the agent's TCP socket looks alive but the path is broken further out.

**Layer 2: A probe that traverses the tunnel itself.** This is the part that is specific to reverse tunnels. It is not enough to ask "is the agent healthy?" (you cannot reach it directly to ask anyway); you need to ask "does traffic still make it from the public side of the relay, through the forwarded port, down the SSH channel, and back?" Run a small health responder on the agent and forward an additional port for it:

```bash
ssh -N -R 12047:localhost:22 -R 12048:localhost:8080 \
    tunnel@relay.example.net
```

Then have the registry probe `relay.example.net:12048/healthz` once a minute. If the response stops, you know the tunnel pathway is broken even if the agent's local /healthz on `127.0.0.1:8080` would answer instantly. A direct /healthz on the agent would tell you nothing here, because you cannot reach it directly; that is the whole point.

**Layer 3: Agent-side self-check.** The agent itself can periodically reach out (HTTPS to the registry, or via the tunnel if HTTPS is not available) and ask: "do you see my tunnel as up?" If the answer is no but the agent thinks its tunnel is up, the agent kills its own SSH process and lets the supervisor restart it. This is the only check that catches the case where the relay-side socket is fine but the relay has been restarted and forgotten about the port reservation.

The loop is small enough to inline:

```bash
#!/usr/bin/env bash
# /usr/local/bin/tunnel-selfcheck, run from a 60s systemd timer
set -euo pipefail
me=$(cat /etc/tunnel/agent_id)
resp=$(curl -fsS --max-time 5 "https://registry.example.net/tunnels/${me}")
last_seen=$(jq -r '.last_seen_at' <<<"$resp")
# treat anything older than 3 minutes as the registry saying "I don't see you"
# requires GNU date; swap for `python3 -c` or `gawk` on BSD/Alpine boxes.
if [[ $(date -d "$last_seen" +%s) -lt $(( $(date +%s) - 180 )) ]]; then
    logger -t tunnel-selfcheck "registry says stale ($last_seen); killing ssh"
    systemctl kill --signal=TERM tunnel.service
fi
```


Together, these three layers reduce mean time to detection from "your CI job times out in 30 minutes" to "the tunnel is back in about 90 to 120 seconds, and you mostly do not notice."

## A small thing about hostnames

When you SSH through a `ProxyJump` to `localhost:12047`, your `known_hosts` ends up full of entries for `[localhost]:12047`, `[localhost]:12048`, etc. They all look the same to SSH, and when port assignments drift (the registry gives bench-17 a new port after it re-registers), you get noisy host-key warnings.

The fix is `HostKeyAlias`:

```
Host bench-17
    HostName localhost
    Port 12047
    ProxyJump tunnel@relay.example.net
    HostKeyAlias bench-17
    User root
```

Now `known_hosts` keys on `bench-17`, not on the port number, and port reassignments do not cause warnings.

## What this is not

This is the right pattern for a few hundred to a few thousand agents. It is not the right pattern for tens of thousands. Past that scale you outgrow SSH and end up reaching for one of two families:

- **Managed reverse-tunnel services.** Cloudflare Tunnel, frp, inlets, and Teleport all run an agent on the unreachable host and a controller you operate (or someone else operates) on the public side. You get the same dial-out shape this post describes, plus connection pooling, identity, and audit baked in.
- **Mesh VPNs.** Tailscale / headscale, Nebula, and ZeroTier put every agent on an overlay network so it is reachable as a first-class participant. Different mental model: there is no "tunnel" you maintain, just a virtual network the agent joins on boot. Worth the switch if you want bidirectional connectivity and not just push-from-client.

Both are bigger commitments than what is described here, and the operational shape is different enough that you should not pick one because reverse-SSH "got hard". Pick one because the size or shape of the problem actually changed.

For boxes behind NAT, reverse SSH plus a port registry plus the three-layer health check covers the common case. The agent owns the connection and the channel lies; design for both.
