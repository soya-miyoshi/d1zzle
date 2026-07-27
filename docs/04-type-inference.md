# 04 — Type inference

Type inference is the whole reason to build this rather than write SQL strings. It is also
the part most likely to become slow and unmaintainable, so the design is as much about
`tsc` cost as about expressiveness.

## Column types

A column carries a single phantom metadata record. One type parameter, not five — a record
is cheaper for the checker to carry around and far easier to extend later without touching
every signature.

```ts
export interface ColumnMeta {
  data: unknown;          // the decoded TypeScript type
  notNull: boolean;
  hasDefault: boolean;

  // Drizzle-facing metadata, carried so its inference helpers and its
  // ecosystem can work off our columns. See doc 10.
  dataType?: DrizzleDataType;      // 'number' | 'string' | 'boolean' | 'date' | …
  columnType?: DrizzleColumnType;  // 'SQLiteInteger' | 'SQLiteText' | …
  driverParam?: unknown;
  enumValues?: readonly string[] | undefined;
}

export declare class Column<M extends ColumnMeta = ColumnMeta> {
  declare readonly $: M;   // phantom, never assigned at runtime
  declare readonly _: DrizzleColumnShape<M>;   // phantom, Drizzle-shaped
  readonly config: ColumnConfig;
}
```

The four extra fields cost nothing at runtime and are what let a Drizzle adapter infer the
same row types from our schema.

`$` is declared but never written. It exists only so the checker has somewhere to hang the
metadata; it costs zero runtime bytes.

The builder narrows the record as methods are chained:

```ts
export declare class ColumnBuilder<M extends ColumnMeta> {
  notNull():    ColumnBuilder<M & { notNull: true }>;
  primaryKey(): ColumnBuilder<M & { notNull: true }>;
  default(v: M['data'] | SQLChunk): ColumnBuilder<M & { hasDefault: true }>;
  $type<T>():   ColumnBuilder<Omit<M, 'data'> & { data: T }>;
}
```

Narrowing by **intersection** (`M & { notNull: true }`) rather than by recomputing the
whole record keeps each step O(1) for the checker. `$type<T>()` is the escape hatch for
branded IDs and JSON payloads.

### The one subtlety worth knowing

A fresh column's metadata starts with `notNull: boolean`, **not** `notNull: false`:

```ts
type Meta<T, …> = { data: T; notNull: boolean; hasDefault: boolean; … };
```

Intersection is how narrowing works, and `boolean & true` is `true`, while
`false & true` is `never`. With `false` as the starting point, `.notNull()` produces a
column whose `notNull` is `never` — and since `never extends true` is *true*, every check
downstream silently passes. Columns would look non-nullable on select and optional on
insert, all at once, with no type error anywhere.

This is the kind of bug that only surfaces as wrong inference, so it is worth stating
plainly: **the starting record must be `boolean`, not the literal.**

## Select and insert inference

```ts
type Out<C> = C extends Column<infer M>
  ? M['notNull'] extends true ? M['data'] : M['data'] | null
  : never;

export type InferSelect<T extends Table> = {
  [K in keyof Cols<T>]: Out<Cols<T>[K]>;
};
```

Insert is the interesting one: a column is **required** only when it is `notNull` and has
no default.

```ts
type RequiredKeys<C> = {
  [K in keyof C]: C[K] extends Column<infer M>
    ? M['notNull'] extends true ? (M['hasDefault'] extends true ? never : K) : never
    : never;
}[keyof C];

export type InferInsert<T extends Table> =
  & { [K in RequiredKeys<Cols<T>>]:  Out<Cols<T>[K]> }
  & { [K in Exclude<keyof Cols<T>, RequiredKeys<Cols<T>>>]?: Out<Cols<T>[K]> };
```

## Builder state threading

Each builder carries one state record and narrows it. This is the same trick as columns,
applied to queries.

```ts
interface SelectState {
  row: unknown;                  // the row an explicit projection produces
  baseName: string;              // the `from` table's name, at the type level
  baseRow: unknown;              // its InferSelect
  joined: Record<string, unknown>;  // one entry per joined table, nullable if outer
  explicit: boolean;             // did the user pass a projection?
}

declare class SelectBuilder<S extends SelectState> implements PromiseLike<Rows<S>> {
  where(c: Condition): SelectBuilder<S>;
  limit(n: number):    SelectBuilder<S>;

  innerJoin<T extends Table>(t: T, on: Condition): SelectBuilder<AddJoin<S, T, false>>;
  leftJoin<T extends Table>(t: T, on: Condition):  SelectBuilder<AddJoin<S, T, true>>;

  get():  Promise<Rows<S>[number] | undefined>;
  all():  Promise<Rows<S>[]>;
}
```

As built, nullability is tracked per joined table rather than as a union of table names,
because the runtime shape it describes is nested: an unqualified `select()` across a join
returns `{ users: {...}, posts: {...} | null }`, so `leftJoin` widens the *group*, not each
column. The mapper mirrors this — if every column of an outer-joined group came back null,
the whole group is `null` rather than an object of nulls.

**Known limitation.** Widening applies to the implicit, grouped shape. An explicit
projection that hand-picks columns across an outer join
(`select({ title: posts.title }).leftJoin(...)`) is *not* widened, because the column's own
type carries no record of which table it came from. The runtime returns `null` there; the
type says otherwise. Fixing it means threading the origin table into `ColumnMeta`, which is
a real cost on every column, and it has not been paid yet.

Joins are where a naive design explodes: modelling them as a growing tuple of table types
and then recursively folding that tuple at the end is the classic way to make a schema
take 30 seconds to check. Fold **incrementally**, at each `join()` call, so the state
record stays flat.

## Keeping `tsc` fast

Deep type-level machinery is the standard failure mode of Drizzle-style ORMs — large
schemas can push editors into multi-second completion latency. These rules are not
stylistic:

1. **Prefer `interface` to `type` for object shapes.** The checker caches interface
   members; large anonymous object type aliases get re-elaborated.
2. **One record type parameter, never a long positional list.** Adding a sixth boolean
   parameter to a generic class multiplies instantiation cost across every method.
3. **Narrow by intersection; do not recompute.** `M & { notNull: true }` beats a mapped
   type that rebuilds every field.
4. **No unbounded recursive conditional types.** Anything recursive gets an explicit depth
   cap and a fallback to `unknown`.
5. **Do not distribute over large unions** in hot paths — that is O(columns) instantiations
   per use.
6. **Apply `Simplify<T>` only at the public boundary** (what the user hovers), never
   internally. Prettifying intermediate types is pure cost.
7. **Avoid `infer` chains.** One `infer` per conditional; extract helpers instead of
   nesting three deep.

### Enforcement

`tsgo --extendedDiagnostics` reports instantiation counts. CI records the count for a
fixture schema (20 tables, ~150 columns, a few joins) and **fails the build on a regression
beyond a set threshold**. Type performance is a budget like bundle size, not a vibe — and
it is the metric that decays silently if nobody watches it.

Type-level behaviour itself is covered by `expectTypeOf` assertions, checked by `tsgo`
rather than at runtime: `test/unit/drizzle-types.test.ts` asserts our `InferSelect` /
`InferInsert` agree with Drizzle's `InferSelectModel` / `InferInsertModel` field for field.

One difference that surfaced there and is worth recording: under
`exactOptionalPropertyTypes`, our optional insert keys are `k?: T` while Drizzle's are
`k?: T | undefined`. Values and key sets match exactly; our type is assignable to theirs,
which is the direction that matters, but the two are not *identical* by
`toEqualTypeOf`.

**The instantiation-count budget described above is not wired into CI yet** — see
[07](./07-roadmap.md).

## TypeScript 7

The project builds and type-checks with `@typescript/native-preview` (`tsgo`), the Go port.
Two implications:

- It is a **preview**. Pin the exact version and upgrade deliberately. If `tsgo` emit turns
  out to be unreliable for declaration files, the fallback is `tsgo` for `--noEmit`
  checking plus the stable `tsc` for emit — the source is unaffected either way.
- Faster checking removes the excuse for sloppy type design, but does not remove the
  problem: an O(n²) conditional type is still O(n²). The rules above stand.
