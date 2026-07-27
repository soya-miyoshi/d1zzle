/**
 * The joint property the two snapshot builders have to satisfy.
 *
 * `snapshotFromSchema` and `snapshotFromIntrospection` describe the same
 * database from opposite directions, and nothing forced them to agree — so
 * they didn't. Building the fixture schema and diffing the introspected result
 * against the schema-derived one produced 18 statements, three of them
 * `drop table`, which meant `check` exited non-zero on a perfectly in-sync
 * database and `push` rebuilt every table on every run.
 *
 * This asserts the property directly: build from the schema, read it back,
 * expect no work to do. It is the one test that covers both builders and the
 * differ's notion of equality at once.
 */
import { env } from 'cloudflare:test';
import { createSchema } from 'd1zzle/ddl';
import { beforeEach, describe, expect, it } from 'vitest';
import { introspect } from '../../src/core/apply.js';
import type { SqlRunner } from '../../src/core/apply.js';
import { diffSnapshots } from '../../src/core/diff.js';
import { snapshotFromSchema } from '../../src/core/snapshot.js';
import { allTables } from '../../../test/schema.js';
import { check, integer, sql, sqliteTable, text, uniqueIndex } from 'd1zzle';

/**
 * Declared here rather than in the shared fixture, which misses this by one
 * character: its predicate is `sql\`${t.active} = 1\``, where the `1` is
 * template text and no parameter slot is created. Interpolating the value
 * instead — `${1}` — is what exercised the padding in `renderInline`.
 */
const flags = sqliteTable('flags', {
	id: integer('id').primaryKey(),
	name: text('name').notNull(),
	// `pragma table_info` cannot see these at all, so a schema using one
	// drifted against itself on every check and push. The expression has
	// parentheses on purpose: the CREATE TABLE parser used to stop at the
	// first `)` and miss the `stored` that follows.
	shout: text('shout').generatedAlwaysAs(sql`upper("name")`, { mode: 'stored' }),
	slug: text('slug').generatedAlwaysAs(sql`lower(trim("name"))`, { mode: 'virtual' }),
	active: integer('active').notNull().default(0),
	weight: integer('weight'),
}, (t) => [
	uniqueIndex('flags_active_idx').on(t.name).where(sql`${t.active} = ${1}`),
	check('flags_weight_check', sql`${t.weight} >= ${0}`),
]);

const schemaTables = [...allTables, flags];

const DB = (env as { DB: D1Database }).DB;

const runner: SqlRunner = {
	all: async <T>(sql: string) => (await DB.prepare(sql).all<T>()).results as T[],
	batch: async (statements) => {
		await DB.batch(statements.map((sql) => DB.prepare(sql)));
	},
};

beforeEach(async () => {
	const existing = await runner.all<{ name: string }>(
		"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' "
			+ "and name not like '\\_cf\\_%' escape '\\'",
	);
	for (const table of existing) await DB.prepare(`drop table if exists "${table.name}"`).run();
	for (const statement of createSchema(schemaTables)) await DB.prepare(statement).run();
});

describe('schema ↔ introspection round trip', () => {
	it('reports no drift for a database built from the schema it is compared to', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(schemaTables);

		// The fixture is deliberately awkward: a column-level `.unique()`, a
		// column-level `.references()`, a table-level `unique('…')` whose name
		// SQLite discards, a composite primary key, a table-level foreign key,
		// a check constraint and a partial unique index.
		expect(diffSnapshots(live, expected).statements).toEqual([]);
	});

	it('is symmetric — neither direction invents work', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(schemaTables);

		expect(diffSnapshots(expected, live).statements).toEqual([]);
	});

	it('does not report constraint renames across an introspected snapshot', async () => {
		const live = await introspect(runner);
		const expected = snapshotFromSchema(schemaTables);

		// SQLite never returns the declared name, so every constraint would look
		// renamed on `push` and `check` — `"users"` would be reported as renamed
		// from `sqlite_autoindex_users_1` on every run.
		expect(live.origin).toBe('introspection');
		expect(expected.origin).toBe('schema');
		expect(diffSnapshots(live, expected).warnings).toEqual([]);
		expect(diffSnapshots(expected, live).warnings).toEqual([]);
	});
});
