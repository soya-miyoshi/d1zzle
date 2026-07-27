# d1zzle-kit

Migrations, introspection and drift detection for [d1zzle](../README.md) on Cloudflare D1.

A **devDependency**. It runs in Node, and contributes zero bytes to the Worker bundle.

```bash
npm install -D d1zzle-kit
```

```ts
// d1zzle.config.ts
import { defineConfig } from 'd1zzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',          // wrangler's layout, by default
});
```

The database is read from `wrangler.jsonc` / `wrangler.toml` unless you override it.
Duplicated database configuration is a common source of "applied to the wrong database"
incidents, so there is only one place to state it.

## Commands

```
d1zzle-kit generate      # diff schema against the last snapshot → a new SQL migration
d1zzle-kit migrate       # apply pending migrations (--local | --remote)
d1zzle-kit push          # diff and apply directly, no migration file (dev only)
d1zzle-kit pull          # introspect a live database → schema.ts + baseline snapshot
d1zzle-kit check         # detect drift and unapplied migrations; non-zero exit for CI
d1zzle-kit up            # upgrade snapshot format after a kit version bump
```

Flags: `--local` (default) targets the `.wrangler` SQLite state; `--remote` goes through
the D1 HTTP API. `--accept-data-loss` is required for anything destructive.

## What it does differently

**Migrations are atomic.** Each migration file is split into statements and submitted as a
single `batch()`, which D1 executes atomically. Emitting `BEGIN`/`COMMIT` — what a portable
tool does — is not honoured by D1. If a migration is too large for one batch, the split is
reported loudly rather than hidden, because atomicity is lost across it.

**Table recreation is implemented properly.** SQLite can only `ADD COLUMN`, `DROP COLUMN`,
`RENAME COLUMN` and `RENAME TO`. Everything else — a type change, a new `NOT NULL`, a
changed default, any constraint change — rebuilds the table. The column list in the
`INSERT … SELECT` is always computed from the intersection of old and new columns; `SELECT *`
is the classic corruption bug and never appears. Indexes are recreated, because they are
dropped with the table.

**Impossible migrations fail at `generate`, not at apply.** A new `NOT NULL` column with no
default cannot be backfilled, so the kit refuses to write the migration and says why. So
does rebuilding a table that another table references: D1 does not allow
`PRAGMA foreign_keys = OFF` (it cannot be changed inside the implicit transaction D1 runs
every statement in), and `defer_foreign_keys` — which D1 does accept — does not suppress
`ON DELETE CASCADE`, so the `DROP TABLE` step would delete the referencing rows. Drop the
foreign keys in one migration and rebuild in the next. This is the most surprising
restriction in the tool, and it is a property of D1, not of the kit.

**Local and remote share one code path.** Both are the same `SqlRunner` interface, so
`--local` and `--remote` cannot drift apart.

**Drift is a first-class command.** `check` introspects the live database, diffs it against
the snapshot the migrations imply, and reports unapplied migrations, manual `ALTER`s and
anything else that would make the next generated migration compute from a false baseline.

**Wrangler stays interchangeable.** Migrations are written in wrangler's layout and
recorded in wrangler's own `d1_migrations` table, so `d1zzle-kit migrate` and
`wrangler d1 migrations apply` can be used against the same database.

## Studio

Not implemented, on purpose. Use the Drizzle Studio browser extension — it introspects the
live database and never loads a schema file, so it works with d1zzle unchanged — or
Cloudflare's D1 console in the dashboard.

## Programmatic use

Every command is a plain function, and the diff engine is pure:

```ts
import { diffSnapshots, renderMigration, snapshotFromSchema } from 'd1zzle-kit/core';

const sql = renderMigration(diffSnapshots(previousSnapshot, snapshotFromSchema(schema)));
```

`d1zzle-kit/core` has no Node dependencies, so it also runs inside workerd — which is where
the migration engine is tested against a real D1 database.

## License

MIT
