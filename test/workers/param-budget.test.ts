/**
 * D1's bound-parameter budget, at the seams where two correct decisions meet.
 *
 * These run against real workerd + D1 rather than asserting on compiled SQL:
 * the failure being pinned here is `too many SQL variables`, which only SQLite
 * can tell us about.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { blob, drizzle, inArray, integer, sqliteTable, text } from '../../src/index.js';
import { defineRelations } from '../../src/relations/index.js';

const DB = (env as { DB: D1Database }).DB;

// A blob primary key — UUID-as-bytes is a real pattern, and the one key shape
// that cannot collapse to a single `json_each` parameter.
const owners = sqliteTable('pb_owners', {
	id: blob('id').primaryKey(),
	name: text('name'),
});
const items = sqliteTable('pb_items', {
	id: integer('id').primaryKey(),
	ownerId: blob('owner_id').notNull(),
});

// The integer control, so a regression in chunking cannot be mistaken for a
// regression in stitching.
const nOwners = sqliteTable('pi_owners', {
	id: integer('id').primaryKey(),
	name: text('name'),
});
const nItems = sqliteTable('pi_items', {
	id: integer('id').primaryKey(),
	ownerId: integer('owner_id').notNull(),
});

const relations = defineRelations({ owners, items, nOwners, nItems }, (r) => ({
	owners: { items: r.many.items() },
	items: { owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }) },
	nOwners: { items: r.many.nItems() },
	nItems: { owner: r.one.nOwners({ from: r.nItems.ownerId, to: r.nOwners.id }) },
}));

const db = drizzle({ client: DB, relations });

// Comfortably past the default 100-parameter budget.
const N = 150;
const keyOf = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff, 0xaa, 0xbb]);

const allTables = [owners, items, nOwners, nItems];

beforeEach(async () => {
	for (const name of ['pb_items', 'pb_owners', 'pi_items', 'pi_owners']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(allTables)) await DB.prepare(statement).run();

	await db.insert(owners).values(Array.from({ length: N }, (_, i) => ({ id: keyOf(i), name: `n${i}` })));
	await db.insert(items).values(Array.from({ length: N }, (_, i) => ({ id: i + 1, ownerId: keyOf(i) })));
	await db.insert(nOwners).values(Array.from({ length: N }, (_, i) => ({ id: i + 1, name: `n${i}` })));
	await db.insert(nItems).values(Array.from({ length: N }, (_, i) => ({ id: i + 1, ownerId: i + 1 })));
});

describe('relational loads over more parents than the parameter budget', () => {
	it('chunks a blob key, which cannot collapse to json_each', async () => {
		const rows = await db.query.owners.findMany({ with: { items: true } });

		expect(rows).toHaveLength(N);
		expect(rows.filter((r) => r.items.length > 0)).toHaveLength(N);
		// Every parent got its own child, not somebody else's.
		for (const row of rows) {
			expect(row.items).toHaveLength(1);
			expect(row.items[0]!.ownerId).toEqual(row.id);
		}
	});

	it('loads a one relation back across the same blob key', async () => {
		const rows = await db.query.items.findMany({ with: { owner: true } });

		expect(rows).toHaveLength(N);
		expect(rows.every((r) => r.owner !== null)).toBe(true);
		for (const row of rows) expect(row.owner!.id).toEqual(row.ownerId);
	});

	it('control: an integer key still collapses and still stitches', async () => {
		const rows = await db.query.nOwners.findMany({ with: { items: true } });

		expect(rows).toHaveLength(N);
		for (const row of rows) {
			expect(row.items).toHaveLength(1);
			expect(row.items[0]!.ownerId).toBe(row.id);
		}
	});

	it('chunks a blob key under a per-parent window too', async () => {
		const rows = await db.query.owners.findMany({
			with: { items: { limit: 1 } },
		});

		expect(rows).toHaveLength(N);
		expect(rows.filter((r) => r.items.length === 1)).toHaveLength(N);
	});
});

describe('inArray against the budget directly', () => {
	it('names the budget rather than leaking SQLITE_ERROR for binary values', async () => {
		const many = Array.from({ length: N }, (_, i) => keyOf(i));

		await expect(db.select().from(owners).where(inArray(owners.id, many)))
			.rejects.toThrow(/exceeds the bound-parameter limit of 100.*no json_each spelling/s);
	});

	it('lets a collapsible array of the same length through', async () => {
		const many = Array.from({ length: N }, (_, i) => i + 1);
		const rows = await db.select().from(nOwners).where(inArray(nOwners.id, many));

		expect(rows).toHaveLength(N);
	});
});
