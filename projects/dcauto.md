# DCAuto
*A firmware CI fabric for data-center GPUs, built so a single flaky node never stalls a run.*

DCAuto is the platform my team uses to run firmware regressions on the next generation of AMD data-center GPUs. The shape of the problem is this: there are racks of physical test systems sitting in several labs, each one holding a GPU under test, and the firmware team needs a way to ship a build, flash it, run a battery of validation suites, and get the answer back without anyone walking into the lab. Multiply that by a few hundred boards and a few thousand suites a day and the orchestration is the entire product.

I joined the platform team and picked up the slice that matters most when a lab is busy: how a system enters a run, what it does when it falls over mid-run, and how it gets itself back into a state the orchestrator is willing to schedule onto again. That is unglamorous work. It is also the work that decides whether the team trusts the platform or starts running things by hand.

## What was actually broken

The first version of the orchestrator assumed test systems were well behaved. A run would start, the orchestrator would shell into each board, kick off the suite, and wait for the report. If a board hung, the run hung. If a board rebooted into a bad kernel, the orchestrator did not notice until the suite timed out an hour later. If two runs landed on the same board because of a race in the scheduler, the second one would happily clobber the first. None of these were rare events. With a hundred-board pool, something interesting happens to at least one board every few minutes.

The pattern was the same every time. The platform assumed it was the source of truth about what the board was doing, and the board itself had no voice in the matter. So I flipped that.

## Self-check-in

The change was to put a small agent on every test system whose only job was to tell the orchestrator the truth about its own state, on its own cadence. On boot the agent reads its identity, dials home, and announces itself with a fresh boot id. The orchestrator keeps a registry keyed by board, and the agent refreshes its lease in the registry every few seconds. If the lease lapses, the board is presumed offline and the scheduler will not target it.

That sounds obvious in retrospect. The hard part was making it idempotent. If a board reboots in the middle of a run, the agent comes back up with a new boot id, finds a stale registry entry for itself, and needs to take ownership without leaving the previous run in some half-finished state. The takeover is a small atomic operation in the registry that says "I know about the previous boot id, here is mine, and here is what I think happened to the run." The orchestrator can then make a clean decision: retry the suite, mark it failed and move on, or hand it to a human if the board looks unhealthy. The board never has to lie about its history to get back into the pool.

## Fallback recovery

The second slice was what happens when something goes wrong that the agent itself cannot fix. A wedged kernel. A flashing tool that hung. A power cycle that came up into the wrong boot slot. The orchestrator used to give up at this point and page a lab tech. Most of the time the right answer was a power cycle and a re-flash to a known-good firmware, and that is a sequence the platform already knew how to perform on every board.

So I wrote the recovery flow as an explicit state machine that the orchestrator runs whenever a board misses a few leases in a row. It tries the cheap thing first (a soft reboot through the agent), and escalates to harder things (a remote power cycle, a re-image to the last-known-good slot, a full reprovision) only when the cheap thing has not worked. Each step is logged with enough detail that you can look at any board and answer "what did the platform try, in order, before it gave up on you," which is the question the lab techs always ask.

## What shipped

The piece I am most proud of is the boring one. The platform now treats a missing board, a rebooted board, and a freshly imaged board as three flavors of the same event, and the orchestrator never has to special-case any of them. A run that used to stall on a single bad node now drops that node and keeps going. The agent is the only thing on the system that talks to the registry, so there is one code path to reason about, and the registry itself is the source of truth that the dashboards, the scheduler, and the recovery flow all read from.

It is still firmware CI underneath. The interesting parts are still in the validation suites, the bring-up scripts, the people on the firmware team who know what a failing test actually means. What changed is that the platform stopped being a thing they had to babysit.
