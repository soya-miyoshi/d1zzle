# 08 — Drizzle schema compatibility

## The target

An existing Drizzle schema file must work with **one changed import specifier**:

```diff
- import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
+ import { sqliteTable, text, integer, index } from 'd1zzle';
```

Everything below that line stays byte-identical. For projects that would rather not touch
the files at all, a `tsconfig` path alias or bundler alias mapping
`drizzle-orm/sqlite-core` → `d1zzle/sqlite-core` gives a **zero-diff** migration.

This is a hard compatibility target, not a best-effort one. It is what makes the project
adoptable: the schema is the artifact people have the most invested in and the least
appetite to rewrite.

## What compatibility actually requires

Source-level compatibility means matching **call signatures and chained-method names**, not
internal representations. Our `Column` can carry a completely different phantom type as
long as `integer('id').primaryKey({ autoIncrement: true }).notNull()` parses, type-checks,
and produces the same DDL and the same runtime encoding.

### Table definition

```ts
sqliteTable(name, columns, (t) => [ /* extras */ ])
```

- `sqliteTable` is an alias export for our native `table()`.
- The third argument (table extras) must accept both the legacy object-returning form and
  the current array-returning form, since real codebases contain both.

### Columns

| Drizzle | Notes |
| --- | --- |
| `integer(name, { mode: 'number' \| 'boolean' \| 'timestamp' \| 'timestamp_ms' })` | `mode` selects the encoder/decoder pair — exactly what rule R6 already requires |
| `text(name, { length, enum })` | `enum` narrows the TS type to a union; `length` is DDL-only |
| `real(name)`, `blob(name, { mode: 'buffer' \| 'json' \| 'bigint' })`, `numeric(name)` | |
| `customType()` | Maps onto our `$type<T>()` plus explicit encoders |

### Chained modifiers

`.notNull()` · `.primaryKey({ autoIncrement })` · `.default(v)` · `.$defaultFn(fn)` ·
`.$onUpdate(fn)` · `.$type<T>()` · `.references(() => other.col, { onDelete, onUpdate })` ·
`.unique(name)` · `.generatedAlwaysAs(...)`

### Constraints and helpers

`index()` / `uniqueIndex()` with `.on()` and `.where()` · `primaryKey({ columns })` ·
`foreignKey({ columns, foreignColumns })` · `unique()` · `check()` · `sql` template tag ·
all comparison and aggregate operators · `defineRelations()` (behind `d1zzle/relations`).

## Compatibility runs both directions

A consequence worth making explicit: if a d1zzle schema file is a valid Drizzle schema file
modulo its import specifier, then **aliasing the import in reverse turns it back into a
Drizzle schema**. That is what lets `d1zzle-kit studio` delegate to `drizzle-kit studio`
instead of us building a data browser ([09](./09-d1zzle-kit.md#studio)).

This makes "strict subset" a standing constraint, not just an aspiration:

> Every symbol usable in a schema file must also exist in `drizzle-orm/sqlite-core` with
> the same meaning and signature.

Adding a d1zzle-only schema helper — however tempting — silently breaks reverse-aliasing
for every user relying on it. Extensions belong on the **query** side, where no such
constraint applies, or behind a clearly separate import that schema files do not use.

## Compatibility tiers

Not everything can or should be supported. Being explicit about the tiers is what keeps
this from becoming an open-ended obligation.

**Tier 1 — must work identically.** Everything listed above. Covered by `test/schema.ts`,
which is written in the Drizzle dialect and used by the whole suite, plus DDL assertions in
`test/unit/ddl.test.ts` and type assertions in `test/unit/drizzle-types.test.ts`.

**Tier 2 — accepted, ignored, warned.** Options that are meaningless on D1 (`.dump()`
concerns, dialect-specific hints). They parse and type-check so the file compiles; a
`__DEV__` warning explains why they do nothing.

**Tier 3 — compile-time error with a pointer.** `transaction()` is the main one: it exists
as a stub that throws, explaining that D1 has no interactive transactions and pointing at
`batch()`. A loud, immediate failure is the right outcome for something that Drizzle lets
you write but D1 cannot honour
([02](./02-d1-platform.md#no-interactive-transactions)).

## The cost, stated honestly

Compatibility is in **direct tension with goal 2**. Supporting every `mode` variant, both
table-extras forms, and the full modifier chain is more code than a minimal native API
would need.

Concrete impact and mitigations:

- Column `mode` variants are just encoder/decoder pairs. Each is a small function, and the
  factory branches on `mode` once at schema-definition time — not per query.
- `.$defaultFn()` / `.$onUpdate()` require a runtime hook on insert/update paths that a
  minimal design could skip entirely.
- DDL-only options (`length`, `check`, `generatedAlwaysAs`) are stored as inert metadata in
  the core bundle and consumed only by `d1zzle/ddl` and the CLI.

**The core budget is therefore revised from ≤ 15 KB to ≤ 20 KB minified**, and this doc is
the reason. That is still a large reduction against Drizzle's D1 entry point, and it buys
drop-in adoption — a trade worth making. If the budget is later missed, the escape hatch is
to move the compatibility aliases into a `d1zzle/sqlite-core` entry point that re-exports
the native API under Drizzle names, keeping the core entry lean for greenfield users.

## Ecosystem compatibility — where this design was too narrow

The tiers above put Drizzle's internals out of scope. That is right for user code and wrong
for adapters: the validator adapters and Pothos' drizzle plugin read `entityKind`,
`Symbol.for('drizzle:Columns')` and `db._.relations`, because Drizzle has no public API for
describing a schema.

As built, d1zzle matches those internals, and `drizzle-orm`'s own `is()`,
`getTableColumns()` and `getTableName()` work on d1zzle objects — verified against the real
package. One gap is unfixable by any implementation: Drizzle's `Column` declares a
`protected` member, and TypeScript accepts those only from the declaring class, so a cast
(`asDrizzleSchema()`, identity at runtime) is needed at an adapter's type boundary.

The mechanics, the verification and the per-adapter status are in
[10-ecosystem-interop.md](./10-ecosystem-interop.md).

## What compatibility does *not* extend to

- **The query builder's every method.** The common surface (`select` / `insert` / `update` /
  `delete` / `where` / joins / `orderBy` / `limit`) matches. Views, CTEs, and set operations
  are deferred ([07](./07-roadmap.md#deferred)) and will not silently no-op.
- **The v0 `relations()` API.** d1zzle presents Drizzle **v1**'s interface and nothing
  else: `defineRelations`, the RQBv2 `db.query` config, v1's `getTableConfig` shape.
  `relations()`, `One`/`Many` as v0 spelled them, and the `where`/`orderBy` *callback*
  forms are gone rather than deprecated. `drizzle({ client, relations })` is the v1 setup
  line; `drizzle(env.DB, { relations })` is kept as an overload because on Workers the
  binding is the natural first argument. The old `schema` option is accepted and ignored.
- **Drizzle's execution strategy.** v1 answers a relational query with lateral joins and
  JSON aggregation; d1zzle keeps split queries, for predictable `rows_read`, no SQLite
  function-argument cap, and readable SQL in the log. The *interface* is adopted, not the
  plan — see [06](./06-runtime.md).
- **Internal APIs.** Anything under Drizzle's `~/` paths, `entityKind`, or the dialect
  classes. Code reaching into internals is out of scope.

## Verification

Rather than a separate `test/compat/` suite, the **fixture schema every test uses**
(`test/schema.ts`) is written in the Drizzle dialect — `sqliteTable`, `mode` options, both
table-extras forms, the full modifier chain. Compatibility is therefore exercised by all
176 tests rather than by a suite that could quietly diverge from the real one.

On top of that:

0. `test/workers/pothos.test.ts` runs `@pothos/plugin-drizzle` against a real D1 binding in
   workerd — the acceptance test for the v1 interface, and the one whose absence let the
   `getTableConfig` and `instanceof Many` gaps survive unnoticed.

1. `test/unit/ddl.test.ts` asserts the DDL that schema generates.
2. `test/unit/drizzle-types.test.ts` asserts inferred types against **real Drizzle's**
   `InferSelectModel` / `InferInsertModel`, which is the mechanical check this section asked
   for.
3. `test/unit/drizzle-interop.test.ts` calls real Drizzle's runtime helpers on it.
4. `test/workers/*.test.ts` runs it against real D1 in workerd.
