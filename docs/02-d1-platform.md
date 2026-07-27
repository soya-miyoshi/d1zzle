# 02 — The D1 platform

Everything in this document is the substrate d1zzle compiles down to. The API surface
below is transcribed from `@cloudflare/workers-types@4.20260408.1`; treat it as the
contract.

## The complete API surface

```ts
declare abstract class D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession;
  dump(): Promise<ArrayBuffer>;  // deprecated
}

declare abstract class D1DatabaseSession {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  getBookmark(): D1SessionBookmark | null;
}

declare abstract class D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

type D1Result<T = unknown> = D1Response & { results: T[] };
interface D1Response { success: true; meta: D1Meta & Record<string, unknown>; error?: never }
```

That is the entire runtime surface. There is no cursor, no streaming, no connection, no
transaction object. **Nine methods.** An abstraction layer over this is not earning its
bytes.

## `D1Meta` — free, billable telemetry

```ts
interface D1Meta {
  duration: number;          // wall clock, includes network
  size_after: number;        // database size in bytes after the query
  rows_read: number;         // ← billing unit
  rows_written: number;      // ← billing unit
  last_row_id: number;
  changed_db: boolean;
  changes: number;
  served_by_region?: string;
  served_by_colo?: string;
  served_by_primary?: boolean;   // ← whether a replica served this
  timings?: { sql_duration_ms: number };  // excludes network
  total_attempts?: number;       // > 1 means D1 auto-retried
}
```

Two consequences for the design:

- **`rows_read` / `rows_written` are what D1 charges for.** Not CPU, not wall time. An ORM
  that surfaces them per query is directly actionable in a way that a "query took 4ms" log
  is not. See [06-runtime.md](./06-runtime.md#observability).
- **`duration` minus `timings.sql_duration_ms` is the network share.** Usually most of it.
  This is the number that justifies optimizing round trips over string building.

## Reading rows: `all()` vs `raw()`

This is the single most consequential platform detail.

`.all()` returns `results: Record<string, unknown>[]` — the runtime allocates one object
per row, keyed by column name. `.raw()` returns positional arrays, optionally preceded by
a header row of column names.

`.all()` has two problems:

**1. Duplicate column names collide.** For

```sql
select "users"."id", "posts"."id" from "users" join "posts" on ...
```

the row object has a single `id` key. One of the two values is lost. This is a known sharp
edge of D1's object mode, and any ORM reading through `.all()` inherits it: by the time
you hold the row object, the duplicate is already gone, so no amount of downstream
remapping can recover it.

**2. Object construction is wasted work.** D1 builds N objects with string keys; we
immediately re-map them into our own shape. On a 500-row result that is 500 discarded
allocations.

**Decision: the direct read path always uses `.raw()` and maps positionally.** We know the
projection order at compile time, so the header row is unnecessary. `columnNames: true` is
requested only under `__DEV__`, where we assert the returned header matches the compiled
projection — which catches aliasing bugs during development at zero production cost.

## `batch()` — the atomic primitive

```ts
batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
```

Properties that matter:

- **One round trip** for all statements. This is the main lever on real latency.
- **Implicitly transactional.** All statements commit or none do. This is D1's *only*
  atomicity guarantee.
- **Sequential, non-conditional.** Statement N cannot reference statement N−1's results.
  Anything requiring a read-then-write decision needs two round trips.
- **Returns `D1Result<T>[]`, never raw arrays.** There is no `raw` mode for batch, so the
  positional read path above is unavailable inside a batch.

The last point forces a design response: when compiling a statement that may be batched,
detect projection name collisions at compile time and emit generated aliases (`c0`, `c1`,
…) so the object keys are unique. Compilation happens once, so the detection is free. We
alias **only** on collision, to keep logged SQL readable.

## No interactive transactions

D1 does not support `BEGIN` / `COMMIT` spanning separate `prepare()` calls. Statements in
a session are not guaranteed to land on the same connection, so an emitted `BEGIN` may
apply to a different connection than the subsequent writes.

Drizzle nevertheless exposes `transaction()` on its D1 driver, implemented by emitting
`begin` … `commit` / `rollback` as ordinary statements. It type-checks, it usually appears
to work, and it does not reliably give you atomicity.

**Decision: d1zzle does not ship `transaction()`.** `db.batch([...])` is the atomic
primitive. A `db.transaction()` stub exists solely to throw a `__DEV__`-only error
pointing at `batch()`, so people porting from Drizzle get an explanation instead of silent
data corruption. This also removes the entire transaction/savepoint subsystem from the
bundle.

## Documented limits

> ⚠️ Verify these against <https://developers.cloudflare.com/d1/platform/limits/> before
> relying on any specific number — they change. The design implications hold regardless of
> the exact values. Last checked 2026-07-27.

| Limit | Value | Enforced | Design implication |
| --- | --- | --- | --- |
| Bound parameters per query | **100** | compile | `insert().values([...])` **must** chunk. A 10-column table caps at 10 rows per statement. This is not an edge case — it is the common bulk-insert path. |
| Max SQL statement length | 100,000 bytes | compile | Text only; bound parameters travel beside the statement. Reachable by a very wide insert or a long `sql.raw(…)`. |
| Arguments per SQL function | 32 | compile | Constrains how wide a `json_array(...)` projection can be in relational queries, and caps `coalesce()`. |
| Columns per table | 100 | declaration | A wider table cannot be created, so the error belongs at `sqliteTable(…)`. |
| `LIKE` / `GLOB` pattern | 50 bytes | compile, when literal | A pattern supplied through `ph()` is only known at execution and is left to D1. |
| Max query duration | 30 s | — | Fine. |
| Max string / BLOB / row size | 2,000,000 bytes | — | A runtime property of the *values*, not of the query. |
| Queries per Worker invocation | **50 free / 1,000 paid** | dev warning, opt-in | The first plan-dependent limit. See [the `plan` option](#the-plan-option). |
| Max database size | **500 MB free / 10 GB paid** | dev warning, opt-in | Reported as `meta.size_after` on every statement, so it costs nothing to watch. |
| Max storage per account | 5 GB free / 1 TB paid | — | Not visible from inside a Worker. |
| Databases per account | 10 free / 50,000 paid | — | Not our problem, and informs "don't build a sharding layer". |

The **bound-parameter limit is the most important one** and it has no analogue in
server-side SQLite, which is why a D1-tuned ORM should handle it and a portable one
usually doesn't. Multi-row inserts are chunked automatically into a `batch()`, preserving
atomicity across chunks. See [06-runtime.md](./06-runtime.md#multi-row-inserts).

### Why the compile-time ones are checked here at all

Every limit marked *compile* above would also be caught by D1 — as a bare SQLite error,
naming a constraint but not the call that produced it. `too many SQL variables` does not
say which `inArray`, and `too many arguments on function coalesce` does not say which
`coalesce`. Compilation happens once per isolate and already walks the whole query, so the
check is free and the message can name the lever:

```
A statement of 186040 characters exceeds D1's 100000-byte limit on SQL text. Bound
parameters do not count toward it, so this is statement text: a very wide insert, or a
large sql.raw(…) fragment. Lower maxParams (currently 100000) to chunk into shorter
statements, or shorten the fragment.
```

Two of them are only *partly* checkable, and the docs should say so rather than imply
coverage that is not there:

- **Pattern length** is checked when the pattern is a literal at the call site, which is
  what people write. A `ph()` placeholder is filled after compilation and a column or
  fragment is evaluated by SQLite; both are left to D1.
- **Statement length** is checked, but nothing *chunks* on bytes. Chunking divides by
  `maxParams`, which is the correct divisor for the case that reaches this, so lowering
  `maxParams` shortens statements proportionally and is the fix. Re-chunking on a second
  axis would make the emitted statement count depend on identifier lengths, which is worse
  than naming the budget — the same call `inArray` makes when it cannot collapse an array.

A `json_each` payload is a bound parameter, not statement text, so a long `inArray` does
**not** trip the length limit. That is the point of the strategy, and worth stating
because the opposite is the natural guess.

### The plan option

Two limits differ by plan, and neither can be known before a statement runs. `plan` opts
into a dev-only warning for each:

```ts
const db = drizzle(env.DB, { plan: 'free' });
```

- **Queries per invocation.** Counted per database object, including every member of a
  `batch()` individually — which is how D1 counts them. The count is shared with the
  databases `withSession()` derives, because the limit belongs to the invocation and not
  to the session.
- **Database size.** Warns once past 90% of the plan's cap, read from `meta.size_after`.

Both warn **once** per database object. Past the line every subsequent statement is also
past it, and repeating the claim buries it.

Left unset, neither fires. Guessing would either cry wolf on a paid database or stay
silent on a free one, and there is nothing in the binding that reveals the plan.

The honest caveat: counting per database object is exact for the ordinary
`drizzle(env.DB)`-inside-`fetch` shape and **over-counts** for a database hoisted to
module scope and reused across requests. Warning once is what keeps that case from being
actively misleading, and the message says so. Nothing here is plan-*configuration* in the
sense of changing what d1zzle compiles: the bound-parameter budget is 100 on both plans,
and `maxParams` remains the way to change it.

## Workers runtime constraints

- **No `eval`, no `new Function`.** Rules out JIT-compiled row mappers. (Rule R2.)
- **No Node builtins** unless `nodejs_compat` is enabled, which we must not require.
  No `Buffer`, no `crypto` module — `crypto.subtle` and `TextEncoder` are globals and are
  fine.
- **Module scope persists across requests** within an isolate, but an isolate can be
  evicted at any time. This is exactly the property that makes compile-once memoization
  pay off, and also why it must degrade gracefully to "compile on first use".
- **Startup CPU is billed and limited.** Bundle size matters as parse time, not as a
  storage cap — the 3 MB (free) / 10 MB (paid) compressed limits are never binding for an
  ORM.

## The Sessions API

`withSession(constraintOrBookmark)` returns a `D1DatabaseSession` with sequential
consistency: writes made through the session are visible to later reads through it.

```ts
type D1SessionConstraint =
  | "first-primary"        // first query hits primary; rest may hit consistent replicas
  | "first-unconstrained"  // first query may hit any replica; rest stay consistent with it
```

`session.getBookmark()` returns an opaque string encoding "at least this fresh". Passing a
bookmark into `withSession(bookmark)` on a later request resumes that consistency point —
which is how read-your-writes works across separate HTTP requests (stash the bookmark in a
cookie or Durable Object).

This is D1's read-replication story and it is genuinely D1-shaped: it has no analogue in
Postgres or MySQL drivers, so a dialect-agnostic ORM has nowhere natural to put it.
Making it first-class is one of the clearest wins available. See
[06-runtime.md](./06-runtime.md#sessions-and-read-replication).

## Verified against a real D1 database

Everything above was transcribed from types and documentation. This section records what
the test suite actually observed, running inside workerd against a live D1 binding
(`test/workers/`, `kit/test/workers/`). Where the two disagree, this section wins.

| Claim | Result |
| --- | --- |
| `batch()` is atomic | **Confirmed.** A batch whose second statement violates a unique constraint leaves zero rows from the first. A 120-row chunked insert whose last chunk conflicts inserts nothing. |
| Duplicate column names collide in keyed results | **Confirmed**, and handled: colliding projections are aliased `c0…cN` at compile time, and a join with two `id` columns maps correctly inside `batch()`. |
| `.raw()` returns no `D1Meta` | **Confirmed.** This is why `onQuery` switches selects to the keyed path — see [06](./06-runtime.md#observability). |
| `json_each` is available | **Confirmed.** A 201-element `inArray` runs as one bound parameter. |
| `pragma table_info` / `index_list` / `index_info` / `foreign_key_list` | **All available**, and are what introspection is built on ([09](./09-d1zzle-kit.md)). |
| `sqlite_master` is readable | **Confirmed**, including index `sql` text, which is where partial-index `WHERE` clauses and `CHECK` constraints are recovered from. |
| `CHECK`, composite `PRIMARY KEY`, partial and unique indexes, `RETURNING` | All work as declared, and are exercised by the fixture schema. |
| Sessions and bookmarks | `withSession(...)` reads its own writes, and a bookmark round-trips into a second session. |
| `D1Meta.rows_read` / `rows_written` | Populated on every statement, including each one inside a batch. |

Two conservative choices the tests informed rather than forced:

- **`RETURNING` projects unqualified column names.** SQLite's grammar for `RETURNING` is
  narrower than for `SELECT`, and nothing is gained by qualifying names in a clause that
  can only refer to one table.
- **A multi-row `INSERT` never relies on the `DEFAULT` keyword inside `VALUES`.** Rows
  whose supplied keys differ are grouped into separate statements instead, which is
  portable and makes the emitted SQL obvious. See
  [05](./05-query-compilation.md#insert-grouping-and-chunking).

There is also a table that shows up in `sqlite_master` and belongs to nobody's schema:
**`_cf_METADATA`**, D1's own bookkeeping. Introspection filters it along with `sqlite_%`
and the migrations table.
