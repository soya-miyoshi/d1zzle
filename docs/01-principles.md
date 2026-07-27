# 01 — Principles

## Goals

1. **Type inference on par with Drizzle.** Schema definitions produce fully typed rows,
   typed inserts, and typed partial selections. This is the reason the project exists;
   nothing else may compromise it.
2. **Minimal cold-start cost.** Target ≤ 15 KB minified for the core entry point — revised
   to ≤ 20 KB by [08](./08-drizzle-compatibility.md). Every byte is parsed on every cold
   isolate and billed as startup CPU. **Unverified as built:** the measurement harness is
   the one M1 deliverable still missing, so this number is a target, not a result.
3. **Round-trip awareness.** The dominant cost of a D1 query is the RPC, not the SQL
   string building. The API should make the cheap thing (one `batch()`) easy and the
   expensive thing (N sequential awaits) visible.
4. **Cost transparency.** D1 bills by rows read and rows written. Those numbers come back
   on every response; the ORM should surface them rather than throw them away.
5. **Zero runtime dependencies.** No Node builtins, no polyfills, no transitive surprises.
6. **Accept Drizzle schemas unchanged, and be accepted by Drizzle's ecosystem.** An
   existing `drizzle-orm/sqlite-core` schema file must work after changing the import
   specifier and nothing else. As built, this goal grew: adapters (the
   validator adapters, Pothos' drizzle plugin) read Drizzle's *internals*, so a d1zzle
   schema now satisfies those too. See [08](./08-drizzle-compatibility.md) and
   [10](./10-ecosystem-interop.md).
7. **Migration tooling that actually works on D1.** `drizzle-kit` for D1 is the weakest
   part of the Drizzle-on-Workers story. A `d1zzle-kit` CLI with the same command surface,
   built around D1's real constraints, is a first-class deliverable rather than an
   afterthought. See [09-d1zzle-kit.md](./09-d1zzle-kit.md).

## Non-goals

- **Multi-dialect support.** No Postgres, no MySQL, no better-sqlite3, no `bun:sqlite`,
  no Durable Object SQLite. The moment a second backend is supported, the abstraction tax
  that makes Drizzle large comes back. If you need portability, use Drizzle — that is a
  legitimate answer and the README should say so.
- **Interactive transactions.** D1 cannot do them. See [02](./02-d1-platform.md#no-interactive-transactions).
- **A runtime migration engine.** Migrations are generated and applied by the CLI, never
  by the Worker. `d1zzle-kit` is a devDependency and contributes **zero bytes** to the
  Worker bundle; it may use Node freely. This is the line that keeps goal 7 from
  conflicting with goal 2.
- **Runtime schema validation.** Zod/Valibot adapters belong in a separate package, if ever.
- **Query result caching.** Drizzle ships a cache layer. Workers already have Cache API and
  KV; an ORM-level cache is the wrong altitude and costs bytes.

## Design rules

These are the tie-breakers when two designs both work.

### R1 — Pay at compile time, not request time

Anything derivable from the schema and the query shape is computed once and memoized:
SQL text, parameter extraction plan, row mapper, column aliasing. Request time should be
`bind(...params)` plus a positional map over the result.

### R2 — No dynamic code generation

Workers forbid `eval` and `new Function` at runtime. The usual ORM trick of JIT-compiling
a row mapper into source text is unavailable. Use monomorphic closures over precomputed
arrays instead, and keep those loops shape-stable so V8 can inline them.

### R3 — Prefer closures and plain objects over class hierarchies

Every level of `class A extends B extends C` is prototype setup executed at module init
and bytes in the bundle. Classes are fine where they model one concrete thing (a compiled
query, a session); they are not a substitute for composition.

**One documented exception, in `src/schema/drizzle-entity.ts`.** Drizzle's ecosystem
recognises entities by walking the constructor's `entityKind` chain, so tables and columns
need real ancestors to be recognisable at all. The classes are empty, the depth is three,
and goal 6 is the reason. Everywhere else the rule holds — the session API, for instance,
adds `bookmark()` by composition rather than by extending the database class.

### R4 — Dev-only code must be strippable

Helpful errors, SQL logging, alignment assertions, and cost warnings all live behind a
`__DEV__` constant that the build replaces with `false`, so minifiers eliminate the
branches. Never ship a diagnostic that costs bytes in production.

### R5 — Optional subsystems live behind separate entry points

`d1zzle` (core) must not transitively reach relations, DDL generation, or logging
helpers. If a user never writes a relational query, they must not parse that code.

**As built, the rule moved down one entry.** `drizzle({ client, relations })` has to return
`db.query`, or goal 6's one-line migration does not work — so the root entry reaches
`relations/`, and `d1zzle/core` is the entry that keeps R5 exactly. `ddl.ts` is reached by
neither.

### R6 — Never guess at a value's encoding

SQLite has four storage classes. Every column declares its own `toDriver`/`fromDriver`
pair, and the compiler wires the right one into the param plan and row mapper. There is
no global "coerce anything" path, because that is how booleans and dates silently rot.

### R7 — Measure before claiming

Bundle size, cold-start CPU, and rows-read are tracked in CI against a Drizzle baseline
from the first milestone. Any performance claim in the README must point at a number
produced by that harness.

**This rule is currently being broken.** The harness does not exist yet, so every size and
speed statement in these documents is a design intention. The correctness claims are a
different matter: those are backed by 176 tests, the ones that touch D1 running inside
workerd against a real binding. Where a document states a number, assume "unmeasured"
unless it points at a test.
