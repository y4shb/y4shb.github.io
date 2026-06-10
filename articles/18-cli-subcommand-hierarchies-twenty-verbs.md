# Designing CLI subcommand hierarchies that scale past twenty verbs

*how to reorganize a command-line tool once it has too many subcommands to scan, using a fleet management CLI as the worked example*

A fleet management CLI is the tool an operations team uses to drive physical machines at scale: provision a box, reboot it, take it out of rotation, read its logs. If you have used Kubernetes, `drain` (move all work off a node and stop scheduling) and `cordon` (mark a node unschedulable) will feel familiar, except here they act on real hardware rather than pods. A fleet CLI starts out as five verbs: `provision`, `reboot`, `drain`, `status`, `logs`. Nobody writes a design doc. Somebody adds `cordon`, then `uncordon`, then `quarantine`. Six months in there are nineteen verbs, and the on-call runbook has phrases like "remember that `recover` is different from `reset`, and `restart` is just `reboot` for the BMC." The BMC, or Baseboard Management Controller, is a small management chip on the motherboard that can power-cycle the machine independently of the operating system, which is why rebooting the OS and resetting the BMC are genuinely different operations.

That is the point where the tool stops being usable by anyone new: it still works, but new hires have to read the source code to figure out which verb does the thing they want. Fixing it is mostly about naming and grouping, partly about not breaking people's muscle memory, and slightly a debate about whether `fleet host reboot` reads better than `fleet reboot host`.

I reorganized one of these recently. A tool called `flx` had grown to 34 top-level verbs over two years. The rewrite changed how a new operator finds a command: instead of searching the help text for a matching word, they press Tab to see the available groups and drill down. A separate change, adding short aliases for the four most-used verbs, cut average command length from 47 keystrokes to 24, measured across a month of shell history from a small operator group. What follows is what worked, what didn't, and the parts I would do differently.

## What flat sprawl actually looks like

The starting point looked like this in `--help`:

```
flx 1.0
USAGE: flx <command> [args...]

COMMANDS:
  provision      reboot         restart        drain
  cordon         uncordon       quarantine     release
  status         describe       inspect        logs
  events         topology       neighbors      power
  bmc-reset      bmc-update     bmc-status     firmware
  pkg-list       pkg-install    pkg-remove     pkg-pin
  user-add       user-remove    user-list      role-grant
  role-revoke    audit          export         import
  diff           snapshot
```

Thirty-four verbs, no grouping, sorted alphabetically. The problems compound:

- `reboot` and `restart` and `bmc-reset` overlap in a way only the original author understood
- `pkg-*` and `user-*` and `bmc-*` and `role-*` are clearly noun prefixes pretending to be verbs
- tab completion offers thirty-four options after `flx <TAB>`, which is the same as offering zero
- the help text scrolls past one screen on a 24-line terminal, so the bottom verbs are functionally invisible
- nobody can remember whether the snapshot verb takes a hostname first or a snapshot name first, because the entire surface is positional and inconsistent

The `pkg-`, `user-`, `bmc-`, `role-` prefixes are the giveaway: the team had already been grouping informally with hyphens without turning it into real structure. That is the moment to introduce a second level.

## Three taxonomies, briefly

Before redesigning anything, pick a shape. There are three serious options, and the choice cascades through completion, docs, and aliases. One rule decides the layout: whichever axis is wider and more open-ended (more verbs, or more nouns) goes in the *second* position, because tab completion prunes best when a narrowing choice comes first.

| layout | example | strengths | weaknesses |
|---|---|---|---|
| verb-first | `flx reboot host h-42` | reads like English, short for one-off actions | verbs collide across nouns (reboot host vs reboot bmc), help becomes a verb dump |
| noun-first | `flx host reboot h-42` | groups by object, completion narrows fast, scales to hundreds of verbs | feels backwards for muscle-memory verbs (`flx host status` vs `flx status`) |
| capability-grouped | `flx ops reboot host h-42` | clean for permissions, where each top-level group is its own permission boundary | extra typing for every command, the top level is abstract and people have to guess which group an action lives in |

Role-Based Access Control (RBAC) means permissions are attached to roles, such as "operator" or "read-only," rather than to individual users. You grant a role a set of permissions, then assign people to roles.

`git` is verb-first and got away with it because the verbs are universal enough (`clone`, `commit`, `push`) that you don't fight muscle memory. It also has well over a hundred verbs across porcelain and plumbing (https://git-scm.com/docs/git) - git's high-level user-facing commands and its low-level scriptable internals - which is why `git help -a` is unreadable and why every team has a wiki page of "the seven git commands you actually need."

`kubectl` is verb-first at the top (`get`, `describe`, `apply`, `delete`) but the noun comes second and is required (`kubectl get pods`), with a few noun-first exceptions like `kubectl rollout` and `kubectl config`. It holds up because the verbs are the narrow axis and the nouns are the wide one: users can register their own object types, called Custom Resource Definitions (CRDs) - a way to teach Kubernetes about a new kind of object so that `kubectl` manages it like a built-in one - so the noun set grows without the tool changing.

`aws` and `gcloud` group by service noun first (`aws ec2 ...`, `gcloud compute instances ...`), though individual operations are themselves verb-noun (`describe-instances` (https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-instances.html), `instances list`). With hundreds of nouns and thousands of leaf commands the nouns are overwhelmingly the wide axis. kubectl is the useful counterexample: noun-first is a strong convention, not a law.

For fleet management the same rule picks noun-first: 34 verbs against roughly 6 candidate nouns, so the verbs are the wide axis and belong second. The actions also cluster naturally by what they act on, and the verbs are not universal: `drain` means something specific to a host, `pin` means something specific to a package version, and pretending they are general verbs invites collisions.

## The target shape

We landed on three top-level nouns plus one escape hatch:

```
flx host    <verb>  [args]   # anything that acts on a physical machine
flx pkg     <verb>  [args]   # firmware, BMC images, OS packages
flx access  <verb>  [args]   # users, roles, audit
flx ops     <verb>  [args]   # snapshots, exports, cross-cutting
```

`ops` is the escape hatch for "this doesn't fit a noun" commands. Every CLI of size has one. Resist the urge to make it bigger than the real nouns. If `ops` grows past about five verbs, you missed a noun.

Under each noun, verbs are short and consistent. Same verbs mean the same thing across nouns where possible:

```
flx host reboot h-42
flx host drain h-42
flx host status h-42
flx host logs h-42 --since 10m
flx host quarantine h-42 --reason "power supply flapping"

flx pkg install firmware-bmc-1.4.2 --to h-42
flx pkg list --installed --on h-42
flx pkg pin firmware-bmc-1.4.2 --on h-42
flx pkg diff h-42 h-43     # compare the installed packages on two hosts

flx access user add alice --role operator
flx access role grant operator host:reboot,host:drain
flx access audit --since 24h --user alice

flx ops snapshot create --tag pre-upgrade
flx ops export inventory --format json
```

The verbs that did the same thing under different names (`reboot`, `restart`, `bmc-reset`) collapsed into `flx host reboot` with a `--target {os,bmc}` flag, default `os` - one power-cycle action aimed at two targets, and `os` is what operators mean almost every time. The verbs that were noun-prefix masquerades (`pkg-install`, `user-add`) lost the prefix and became proper subcommands. The catch-all verbs (`describe`, `inspect`) merged into `status` with verbosity flags.

The total verb count under the new tree is still 34: the work was redistributed, not removed. But the verbs split roughly as host ~12, pkg ~9, access ~8, ops ~5, so each noun's `--help` now shows a screen-sized list, and tab completion at the first level offers four options instead of thirty-four.

## When to introduce the second level

The rule I use: introduce a noun layer when any of the following is true.

- You have more than 12-15 top-level verbs and `--help` no longer fits on one screen.
- You see informal noun-prefixing in the verb names (`pkg-install`, `bmc-reset`).
- The same verb means meaningfully different things depending on context (`reboot` a host vs `reboot` a service).
- You want RBAC boundaries that map cleanly to subtrees (read-only users get `host status` and `host logs` but not `host *`).
- Tab completion at the top level returns enough options that users ignore it and type the verb from memory.

Fewer than 12 verbs and you're better off staying flat. The second level adds typing for everyone in exchange for organization that doesn't pay off at small scale. `cat`, `ls`, `grep` are flat and should stay flat.

Of these signals, the noun-prefixing one is the most reliable: git, docker (`docker rm` becoming `docker container rm`), kubectl, and aws all evolved hyphen-or-prefix conventions into real subcommand syntax. The "12-15 verbs / one screen" threshold is my own rule of thumb, so treat the number as a nudge. The more honest signal is when you find yourself writing internal docs that say "to do X, run `flx foo`; not to be confused with `flx bar` which is similar but different." You needed the noun layer a couple of verbs ago.

## Aliases for muscle memory

Reorganizing a CLI that people use every day has a real cost: for the first couple of weeks, every command the on-call team has saved in shell history and written into runbooks is now wrong.

Two flavors of alias matter:

**Top-level shortcuts** for the verbs that account for the bulk of daily use. Track shell history for a week and ship a config:

```
flx reboot       -> flx host reboot
flx status       -> flx host status
flx logs         -> flx host logs
flx drain        -> flx host drain
```

These four were ~70% of invocations in the history, and aliasing them down to a single word is where almost the whole keystroke drop came from. Muscle memory keeps working while the new hierarchy is there for everything else. You print a notice that the short form is being phased out (written to standard error, the output stream meant for diagnostics, so it does not corrupt piped output) for the first month, and then you quietly leave the aliases in forever.

**Compact paths** for common drilldowns:

```
flx h <id>       -> flx host status <id>
flx hl <id>      -> flx host logs <id>
```

Two-letter aliases are aggressive but they earn their keep for commands you run dozens of times an hour. The convention I like: first letter of each noun in the path. `hl` is unambiguous; we skipped `hs` because it would collide with a planned `host snapshot` verb, keeping the two-letter space clear for it.

The deprecation policy that worked: aliases are forever; only the hyphenated `pkg-install`-style legacy forms got a real removal date. They printed:

```
WARN: 'flx pkg-install' is deprecated and will be removed in v2.0 (2026-09-01).
      Use 'flx pkg install' instead.
```

Three releases later, the legacy forms were gone. The single-word aliases (`reboot`, `status`, `logs`) stayed.

## Tab completion that stays useful

A noun-first layout only pays off if tab completion is wired correctly. Three things matter.

First, **dynamic completion at every level**. Completion that lists the fixed subcommands is the easy part. But the final argument is often a hostname or package name, and to complete that the tool has to ask the live inventory what hosts and packages exist. In the sketch below, the load-bearing parts are the hidden `flx __complete` subcommand that feeds candidates from live data and the `cword` case that decides what to suggest based on where the cursor is (`words[1]` is the noun, `words[2]` the verb):

```bash
# bash completion stub, the real one is generated
# real implementation uses null-separated output and `mapfile` to handle spaces in names
_flx() {
  # _init_completion is a bash-completion helper that fills in cur/prev/words/cword:
  #   cur = the word being typed, words = all words so far, cword = its index
  local cur prev words cword
  _init_completion || return
  case "$cword" in
    # compgen -W "list..." filters a fixed word list down to what matches cur
    1) COMPREPLY=($(compgen -W "host pkg access ops" -- "$cur")) ;;
    2) COMPREPLY=($(compgen -W "$(flx __complete verbs ${words[1]})" -- "$cur")) ;;
    *) COMPREPLY=($(compgen -W "$(flx __complete args ${words[1]} ${words[2]})" -- "$cur")) ;;
  esac
}
complete -F _flx flx
```

The `__complete` subcommand is hidden, returns whitespace-separated tokens, and caches inventory lookups for a few seconds so hitting Tab repeatedly doesn't overload the inventory service. Without it, the user types `flx host reboot h-` and stares at a blinking cursor.

Second, **help integration**. `flx host` with no verb should print the verbs under `host` with one-line descriptions, not error out. `flx host --help` should be the same with more detail. `flx host reboot --help` should show flags and an example. All three should work, which sounds obvious until you find a CLI where the top-level `--help` is great and `flx host --help` segfaults.

Third, **fuzzy matching for typos**. If a user types `flx host rebot`, the CLI should suggest `reboot` rather than erroring:

```
$ flx host rebot h-42
error: 'rebot' is not a valid verb under 'host'
did you mean: reboot? (run 'flx host --help' for a list)
```

A Damerau-Levenshtein distance of 2 or less is a common cutoff. Edit distance is the minimum number of single-character inserts, deletes, and substitutions to turn one string into another; the Damerau variant also counts a swap of two adjacent characters as one edit, so it catches a deletion like `rebot` cheaply. Don't auto-correct, just suggest: auto-correcting a destructive verb can power-cycle the wrong machines.

## The migration cost, honestly

The restructure took about three weeks of one engineer's time, plus a week of fixing runbook references, plus a week of dashboards calling shell scripts that called the CLI. The actual code refactor was a day. The rest was migration.

What I'd do differently:

- Ship the aliases on day one, not day fourteen. We thought we'd be fine without `flx reboot` aliasing and got loud feedback within hours.
- Generate the completion scripts automatically from one definition, as part of the build pipeline, instead of hand-maintaining separate bash, zsh, and fish versions. We did this eventually but should have started there.
- The hidden `__complete` subcommand needs a stable contract. We changed its output format once and broke completion for everyone who hadn't reinstalled the completion script. Treat its output format as something other programs depend on, and don't change it casually.

We scoped the RBAC grants to `noun:verb` (`host:reboot`) rather than bare verbs, so a role can be granted `host:status` without also getting `pkg:status`. That scoping is what made the noun-first tree map onto permissions cleanly, and it is why we never needed the capability-grouped layout to get clean RBAC boundaries.

The halving of keystrokes came from the aliases, not the grouping. The grouping pays off in discoverability: new hires can guess `flx host` and see what verbs exist, instead of searching the help output for whichever verb sounds right. They no longer have to already know the answer to find the command.
