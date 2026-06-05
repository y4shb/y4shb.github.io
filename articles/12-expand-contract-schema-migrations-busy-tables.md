# Expand and contract schema migrations on busy tables

*five phases, each with its own way to wedge production*

The dual-write rename looks fine on a whiteboard. Add a column, copy the data, switch reads, drop the old column. Four arrows, maybe five. Then you try it on `transactions` at 4,200 writes per second with 900 million rows and a foreign key from `ledger_entries`, and you discover that each arrow is actually a multi-day operation with its own failure modes, its own lock contention story, and its own way of leaving you stranded if you bail halfway.

The pattern I will walk through is the one most teams converge on after they have hurt themselves at least once: expand, backfill, dual-write, cut over reads, contract. The example throughout is renaming `transactions.amount_cents` (a `BIGINT`) to a typed `amount` struct (`amount_value BIGINT`, `amount_currency CHAR(3)`, `amount_scale SMALLINT`) so the system can finally handle JPY and BHD without the comment `-- assume USD` haunting six services. Same table, same row count, same backfill window of roughly 36 hours.

## The five phases, briefly

```
phase 1  EXPAND       add nullable columns, no app changes
phase 2  BACKFILL     copy old -> new in batches, idempotent
phase 3  DUAL-WRITE   app writes both, reads still old
phase 4  CUT READS    flip readers to new, old still written
phase 5  CONTRACT     stop writing old, drop column
```

Each phase is a deployable state. That property is the whole point. If anything goes sideways at phase 3, you roll the app back to phase 2 and nothing breaks, because phase 2 left the database in a state that phase 2's app code still understands. Skip that property and you have a flag day, not a migration.

## Phase 1: add the columns

This is the phase that looks free and is not. `ADD COLUMN` with no default has been metadata-only on Postgres forever; since PG11, even `ADD COLUMN ... DEFAULT 'USD'` is metadata-only via a virtual default stored in `pg_attribute.atthasmissing`. Either way the statement takes an `AccessExclusiveLock` for the metadata update. The lock is held briefly but it queues behind every running statement on the table, and every statement starting after it queues behind it. On a 4k QPS table, "briefly" is the gap between a long-running `SELECT` and your `ALTER`, and if some analyst is running a 90-second aggregate, your one-millisecond DDL blocks every write for 90 seconds.

The fix is `lock_timeout`, set absurdly low, with retry:

```sql
SET lock_timeout = '150ms';
ALTER TABLE transactions
  ADD COLUMN amount_value    BIGINT,
  ADD COLUMN amount_currency CHAR(3),
  ADD COLUMN amount_scale    SMALLINT;
```

If it fails, you sleep a few seconds and try again. The migration runner I have seen work well is a tiny loop that retries for up to an hour and then pages someone, on the theory that an hour of failure means something is genuinely wedged, not just unlucky. MySQL's online DDL story is different (the `INSTANT` algorithm in 8.0.12+ for nullable adds, otherwise `INPLACE` with a metadata lock window), but the principle is the same: short lock window, retry, do not block forever.

Do not add a default value here. The virtual default is fast, but old rows then synthesize the default on read, and you lose the ability to distinguish unwritten rows from rows the app has actually touched. That distinction is exactly what phase 2 needs. Keep the column nullable so the backfill predicate is a simple `WHERE amount_value IS NULL` (see the `atthasmissing` column on [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) for what the virtual default actually stores).

Indexes: do not create them yet. Phase 1 should not create any index on the new column. The reason is phase 2.

## Phase 2: backfill, slowly and on purpose

The backfill is where everyone learns about long transactions. The naive version:

```sql
UPDATE transactions
   SET amount_value = amount_cents,
       amount_currency = 'USD',
       amount_scale = 2
 WHERE amount_value IS NULL;
```

On 900M rows this is a single transaction that takes hours, holds row locks the whole time, generates a vacuum nightmare, and if you cancel it you wait the same number of hours for the rollback. Do not do this. The batched version:

```python
BATCH = 5_000
last_id = 0

while True:
    rows = db.execute("""
        WITH batch AS (
          SELECT id FROM transactions
           WHERE id > %s AND amount_value IS NULL
           ORDER BY id
           LIMIT %s
           FOR UPDATE SKIP LOCKED
        )
        UPDATE transactions t
           SET amount_value = t.amount_cents,
               amount_currency = 'USD',
               amount_scale = 2
          FROM batch
         WHERE t.id = batch.id
        RETURNING t.id
    """, (last_id, BATCH))

    if not rows:
        break
    last_id = max(r.id for r in rows)
    time.sleep(0.05)  # pace yourself
```

A few things in there are load-bearing.

`FOR UPDATE SKIP LOCKED` means a row that the live application is currently writing gets skipped, not blocked on. You will pick it up on a later pass once `WHERE amount_value IS NULL` catches it again. Without `SKIP LOCKED`, you have built a beautiful denial-of-service on your own write traffic.

The `WHERE id > %s` keyset is necessary because `OFFSET` on a 900M-row table is a war crime. Each batch should be cheap: index lookup, 5k row update, commit, done.

The `time.sleep(0.05)` is your throttle. It looks dumb until you watch replication lag during a backfill that does not have it. On a primary doing 4k writes per second, a backfill that adds another 100k writes per second of UPDATEs generates WAL faster than a physical-replication standby can apply it, since the standby applies WAL in a single startup process. Recovery prefetch and parallel logical apply exist but neither changes that fundamental serial replay on a streaming-replication follower. Read replicas drift hours behind. Pace the backfill. If your replication lag exceeds some threshold, sleep longer. I have run backfills that auto-tune by reading `pg_stat_replication.replay_lag` every batch and adjusting the sleep.

This is where the 36-hour window comes from. Five thousand rows every ~80ms (including the sleep) is about 62k rows per second; 900M / 62k is about four hours of pure work. Once you account for backpressure from replication, contention with live traffic, and the fact that real production has bursts where you should pause entirely, the realistic number is closer to 9x that. ~36 hours is honest.

```
                    pri WAL gen
                       |
   backfill ===>  WAL  v          replay
   batches      ───────►  replica ──────►  apps
       |                     ^
       └── sleep(t) tuned ───┘
           on replay_lag
```

Idempotency here matters in the schema-state sense: if your runner dies at row 412,003,118, you restart from `WHERE amount_value IS NULL` and pick up exactly the rows that did not get done. The `last_id` keyset is just a performance trick; correctness comes from the predicate. This is a different shape of idempotency from the row-level dedup pattern (UNIQUE constraint plus `ON CONFLICT DO NOTHING` inside the same write transaction) that you reach for in message processing; that one belongs in a separate post on exactly-once delivery.

## Phase 3: dual-write

Deploy the app code that, on every write, sets both `amount_cents` and the new three-column struct. Reads still use `amount_cents`. This is where you discover four things in roughly this order:

One, you have writers you did not know about. The Spark job that recomputes daily rollups. The CSV importer from the finance team. The cron in `tools/legacy-fixups/` that nobody has touched since 2021. Every one of them writes `amount_cents` and not the new columns. Each one needs updating, or each one needs a database-level trigger to mirror writes while you find them.

Two, the trigger approach has its own trap. A `BEFORE INSERT OR UPDATE` trigger that does `NEW.amount_value := NEW.amount_cents; NEW.amount_currency := 'USD'; NEW.amount_scale := 2;` works fine and adds a few microseconds per row (the exact number depends on the trigger body and hardware; budget for it in load tests rather than trusting a quoted figure ([postgresql.org/docs/current/plpgsql-trigger.html](https://www.postgresql.org/docs/current/plpgsql-trigger.html))), and breaks the day someone wants to write a non-USD value. So the trigger has to be smart: if the new columns are explicitly set, use those; otherwise derive from old. You end up with a small state machine inside a trigger, which is fine but should be deleted in phase 5 and not forgotten.

Three, the bug where the application sets `amount_cents = 1500` but forgets to set the currency, and the trigger fills in USD, and now you have charged a Japanese customer 1,500 USD instead of 1,500 JPY. The trigger papers over a coding error you would have caught if writes had simply failed. I prefer the application-side dual-write with the trigger only as a safety net that logs a warning whenever it actually fires, so you can hunt down stragglers without breaking production.

Four, transactions across the rename. Anything doing `UPDATE transactions SET amount_cents = amount_cents + 100` (a relative update) needs to do the same arithmetic on `amount_value`. If you miss one, you get silent drift between the two columns. The end-of-phase audit catches this:

```sql
SELECT count(*) FROM transactions
 WHERE amount_value IS DISTINCT FROM amount_cents
    OR amount_currency != 'USD';
```

Run this constantly. The number should be small and bounded (rows currently being written) and should drop to zero between bursts. If it grows monotonically, you have a writer you missed. Stop progressing the migration until you find it.

The audit catches drift, but only after a writer has actually drifted, and it cannot catch a writer that always sets both columns to internally consistent but semantically wrong values (cents vs minor units, for instance). Combine the audit with grep: search the codebase for every reference to `amount_cents` and confirm each one either also writes the new columns or is on a list of known-dead code paths. The audit and the grep cover different failure modes.

## Phase 4: cut over reads

The reads flip behind a feature flag, per-service, ideally per-endpoint. Not a global flag. You want to flip the low-traffic admin read first, watch it for a day, then the customer dashboard, then the high-QPS API. If anything looks wrong (rows missing, wrong currency, performance regression because you forgot the index), you flip back instantly.

This is where you finally create the index on the new columns, after the backfill is done so the index build is on stable data:

```sql
CREATE INDEX CONCURRENTLY transactions_currency_value_idx
    ON transactions (amount_currency, amount_value);
```

`CONCURRENTLY` is non-blocking but slow (it scans the table twice and waits for old transactions to finish), and it can fail mid-build leaving an `INVALID` index that you have to drop and rebuild. Check `pg_index.indisvalid` after; do not assume success because the statement returned.

The bail-out plan in phase 4 is simple: flip the flag back. The data is still being dual-written, so the old column is current. This is the cheapest rollback in the whole migration, and you should rehearse it on staging by deliberately flipping back and forth a few times to make sure nothing caches the schema version weirdly.

## Phase 5: contract

This is the phase that feels anticlimactic and is the riskiest one to do quickly. Steps:

1. Deploy app code that no longer reads or writes `amount_cents`.
2. Wait at least a full deployment cycle, ideally a week, to be sure no rollback brings back code that needs the column.
3. Drop any triggers that touched it.
4. Drop the column.

| step | lock | duration | rollback story |
|------|------|----------|----------------|
| stop writes | none | instant | redeploy old code, dual-write resumes |
| drop trigger | AccessExclusive briefly | ms | recreate trigger |
| drop column | AccessExclusive | ms (metadata) | irreversible without restore |

`ALTER TABLE ... DROP COLUMN` on Postgres is a metadata operation: fast, but takes `AccessExclusiveLock`. Same `lock_timeout` trick as phase 1.

The actual storage does not get reclaimed until rows are rewritten (by `VACUUM FULL`, `CLUSTER`, or a future `pg_repack`). On a 900M-row table this is fine; you do not need to reclaim the space immediately. Schedule `pg_repack` for a quiet weekend if the table size is causing problems for backups.

## Bailing out mid-migration

The point of expand and contract is that every phase is a stable resting state. Translating that into operational reality:

- During phase 1: nothing to bail from, the columns are nullable and unused.
- During phase 2: cancel the backfill runner. The half-filled column is fine; you can resume or abandon. If abandoning, do not skip to phase 5; just leave the columns nullable and unused until you decide what to do.
- During phase 3: deploy back to phase 2 code (single-write to old). The new column will go stale, which is fine because nothing reads it.
- During phase 4: flip the read flag back. Instant.
- During phase 5: this is the one with no easy rollback. Once the column is dropped, restoring it means restoring from backup. So do not enter phase 5 until you are genuinely done.

The pattern I have seen wedge teams: they treat phases 3 and 4 as a single deploy, dual-write and read-from-new in the same release. Now a rollback puts the app in a state that reads from a column whose data is stale by however long the release has been live. The fix is annoying (rerun a small backfill for the affected window) but the principle is more important: every phase should be deployable, holdable, and rollable independently. If you cannot resist the temptation to combine phases, you are not really doing expand and contract; you are doing a flag day with extra steps.

## What this costs

Honest accounting for the running example: about a week of calendar time. One day for phase 1 plus the audit queries plus a deploy. Two days for phase 2 because the 36-hour backfill needs a babysitter and you will pause it during business hours twice. Two days for phase 3 to chase down all the writers and watch the audit query settle. A day for phase 4 to flip reads incrementally. A day in phase 5 to hold the new state before the drop.

That is not a fast migration. It is also not the kind of migration that pages you at 3am with a half-renamed column and a stuck application. The slowness is the feature.

