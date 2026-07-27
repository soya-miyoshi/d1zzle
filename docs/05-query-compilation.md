# 05 — Query compilation

This is the layer that differentiates d1zzle. The claim is not "we generate SQL faster" —
string building is microseconds against a millisecond-scale RPC. The claim is that **a
given query is compiled once per isolate rather than once per request**, and that the
compiled form is shaped for D1's actual read path.

## The plan IR

Builders accumulate an immutable object graph. No SQL text is produced while chaining.

```ts
interface SelectPlan {
  readonly kind: 'select';
  readonly from: Table;
  readonly selection: Selection | undefined;   // undefined = all columns of `from`
  readonly joins: readonly Join[];
  readonly where: SQLChunk | undefined;
  readonly groupBy: readonly SQLChunk[];
  readonly having: SQLChunk | undefined;
  readonly orderBy: readonly OrderBy[];
  readonly limit: number | Placeholder | undefined;
  readonly offset: number | Placeholder | undefined;
  readonly distinct: boolean;
}
```

`InsertPlan`, `UpdatePlan`, and `DeletePlan` are analogous. Every field is `readonly`;
every builder method returns a new plan with one field replaced. Immutability is what makes
per-instance memoization sound.

## `CompiledQuery`

```ts
interface CompiledQuery<TRow = unknown> {
  readonly kind: 'select' | 'insert' | 'update' | 'delete';
  readonly sql: string;
  readonly params: readonly ParamSlot[];
  /** every statement this compiles to; length > 1 only for a chunked insert */
  readonly parts: readonly Query[];
  /** positional path — used with D1PreparedStatement.raw() */
  readonly map: (rows: unknown[][]) => TRow[];
  /** keyed path — used inside batch(), where raw() is unavailable */
  readonly mapKeyed: (rows: Record<string, unknown>[]) => TRow[];
  /** true for a select, or a write with .returning() */
  readonly hasRows: boolean;
  /** output column names, in order; the __DEV__ header assertion checks these */
  readonly columnNames: readonly string[];
  /** tables touched; used by onQuery hooks and dev diagnostics */
  readonly tables: readonly string[];
}
```

`parts` is the piece the original sketch lacked. A multi-row insert that exceeds the
bound-parameter budget compiles to several statements, and the runtime submits them as one
`batch()` — so "one compiled query" and "one D1 statement" are not the same thing, and the
type says so.

Compilation is **pure and synchronous**, and takes no `D1Database`. That is what allows
compiling at module scope, snapshot-testing SQL without workerd, and reusing one compiled
query across every request an isolate serves.

## Memoization

```ts
// in the builder
compile(): CompiledQuery<TRow, TInput> {
  return (this.#compiled ??= compilePlan(this.#plan));
}
```

Sound because plans are immutable — a builder instance can never describe two different
queries. Three usage patterns fall out:

| Pattern | Compilations |
| --- | --- |
| `db.select()...` built inside `fetch()` | one per request |
| `query.select()...compile()` at module scope | one per isolate |
| `db` hoisted via `cloudflare:workers` env, builder at module scope | one per isolate |

There is deliberately **no global structural cache** keyed by a hash of the plan. Hashing a
plan on every request costs more than rebuilding the string, and a shared cache in a
long-lived isolate is an unbounded memory leak. Memoization is per-builder-instance;
reuse is the user's choice, made explicit by where they declare the query.

## Parameter plans

SQL text and parameter values are compiled separately so the memoized text can be reused
with fresh values.

```ts
type ParamSlot =
  | { k: 'const'; v: D1Param }                              // literal captured at build time
  | { k: 'ph'; name: string; encode: (v: unknown) => D1Param };  // filled at execution

function bindParams(slots: readonly ParamSlot[], input: Record<string, unknown>): D1Param[] {
  const out: D1Param[] = new Array(slots.length);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    out[i] = s.k === 'const' ? s.v : s.encode(input[s.name]);
  }
  return out;
}
```

Encoders come from the column definition (rule R6), so `boolean` → `0 | 1` and a
`$type<Date>()` column → epoch integer, without a global coercion path.

Placeholders are created with `ph('name')` and are what make a module-scope compiled query
useful:

```ts
const q = query.select().from(users)
  .where(and(eq(users.tenantId, ph('tenant')), gt(users.age, ph('minAge'))))
  .limit(ph('limit'))
  .compile();
```

`limit`/`offset` accept placeholders too — otherwise pagination would force a recompile per
page, which is exactly the case where reuse matters most.

## Insert grouping and chunking

Two constraints shape the insert compiler, and both are visible in `parts`:

1. **Rows with different key sets cannot share one `VALUES` list.** Rather than depend on
   the `DEFAULT` keyword inside `VALUES`, consecutive runs of identically-shaped rows are
   compiled into separate statements. Column order within a group follows the schema, not
   the object literal, so the SQL is stable regardless of how the caller wrote the rows.
2. **`rowsPerChunk = floor(maxParams / columnsPerRow)`.** Beyond that the group is split
   again. A row wider than `maxParams` cannot be satisfied by any chunking and throws at
   compile time with a message that says so, rather than failing at D1.

`.returning()` is emitted on every part, and the runtime concatenates the results in order
— which is what makes a 500-row insert return 500 rows in input order from one `batch()`.

## Row mappers

Given a projection, compilation produces one closure that turns a result row into a typed
object. Rule R2 forbids `new Function`, so this is a monomorphic loop over precomputed
arrays rather than generated source.

```ts
interface FieldPlan {
  readonly key: string;                          // output property
  readonly index: number;                        // position in the result row
  readonly decode: ((v: unknown) => unknown) | undefined;
  readonly nullableFromJoin: boolean;
}

function buildFlatMapper(fields: readonly FieldPlan[]) {
  return (rows: unknown[][]) => {
    const out = new Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      const obj: Record<string, unknown> = {};
      for (let f = 0; f < fields.length; f++) {
        const fp = fields[f]!;
        const raw = row[fp.index];
        obj[fp.key] = raw === null ? null : fp.decode ? fp.decode(raw) : raw;
      }
      out[r] = obj;
    }
    return out;
  };
}
```

Notes:

- **Skip the decoder when there isn't one.** `text` and `integer` come back from D1 already
  correct; only `boolean`, `json`, and `$type` columns need a decode step. Most projections
  are decoder-free and the branch predicts perfectly.
- **Shape stability matters more than the loop.** Every object is built with the same keys
  in the same order, so V8 gives them one hidden class. This is most of the win, and it is
  the thing a naive `Object.fromEntries` mapper throws away.
- Nested selections (`{ user: { id, name } }`) get a small tree-walking variant. Flat is
  the common case and gets the dedicated fast path.

## Projection aliasing

Selects are read positionally via `.raw()`, so duplicate output names are harmless on the
direct path. Inside `batch()` they are not — D1 returns keyed objects there and duplicates
collide ([02](./02-d1-platform.md#reading-rows-all-vs-raw)).

The compiler therefore:

1. Computes the output name of every projected column. **The output name is the selection
   key**, not the database column name — `select({ who: users.email })` outputs `who`.
2. If **any** two collide, assigns generated aliases `c0…cN` to the whole projection and
   builds `mapKeyed` against those.
3. Otherwise emits the natural names and keys `mapKeyed` by them.

Detection happens once, at compile time, so it costs nothing per request — and aliasing
only on collision keeps logged SQL readable in the common case. An explicit `as "…"` is
emitted only when the key differs from the column's own name, which is why
`select().from(users)` produces `"users"."created_at" as "createdAt"` but
`"users"."email"` plain.

`RETURNING` uses the same machinery with column names left unqualified — see
[02](./02-d1-platform.md#verified-against-a-real-d1-database).

## Compiling `where` and expressions

Expressions are `SQLChunk`s that render into `{ sql, params }`. The `sql` template tag
already handles this: interpolated values become `?` and push a `ParamSlot`; interpolated
chunks are inlined recursively.

Rendering takes a small `RenderContext` — `maxParams`, `jsonEachThreshold`, and
`bareColumns` — which is how the same expression tree serves three callers: a query
(qualified names, parameters bound), DDL (unqualified names, values inlined, because a
`CHECK` or a partial index cannot qualify or bind), and the kit.

Two compile-time constraints come from D1 ([02](./02-d1-platform.md#documented-limits)):

- **`inArray` with a large array** would blow the ~100 bound-parameter budget. Above a
  threshold the compiler emits `json_each` instead, collapsing N parameters into one:

  ```sql
  where "users"."id" in (select "value" from json_each(?))   -- one param: '[1,2,3,…]'
  ```

  SQLite's JSON1 extension is available in D1. This keeps the statement a single prepared
  query with a stable SQL string — so it still memoizes — regardless of array length.
  (Benchmark the crossover point; `json_each` is not free for small arrays.)

- **Multi-row `insert().values([...])`** is chunked. See
  [06-runtime.md](./06-runtime.md#multi-row-inserts).

## Testing compilation

Because compilation is pure, the bulk of the test suite needs no runtime:

```ts
expect(query.select().from(users).where(eq(users.id, 1)).compile()).toMatchObject({
  sql: 'select "users"."id", "users"."email" from "users" where "users"."id" = ?',
  params: [{ k: 'const', v: 1 }],
});
```

These are fast, deterministic, and diff-readable — the right place to catch SQL
regressions. Integration tests in workerd then verify that the SQL actually *runs* and that
row mapping matches, which is a much smaller surface.

As built: `test/unit/compile-select.test.ts`, `compile-write.test.ts` and `mapper.test.ts`
cover compilation and mapping with no runtime at all — including feeding synthetic rows
through `map` and `mapKeyed` to check decoding, nested groups and outer-join nulling.
`test/workers/integration.test.ts` then runs the same shapes against real D1.
