import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSchema } from '../../src/ddl.js';
import { drizzle, eq, integer, primaryKey, ph, sql, sqliteTable, text } from '../../src/index.js';
import { defineRelations } from '../../src/relations/index.js';
import * as schema from '../schema.js';

const DB = (env as { DB: D1Database }).DB;
const db = drizzle({ client: DB, relations: schema.relations });

beforeEach(async () => {
	for (const name of ['post_tags', 'posts', 'users']) {
		await DB.prepare(`drop table if exists "${name}"`).run();
	}
	for (const statement of createSchema(schema.allTables)) await DB.prepare(statement).run();

	await db.insert(schema.users).values([
		{ id: 1, email: 'a@b.c', name: 'Ada', createdAt: new Date(0) },
		{ id: 2, email: 'b@b.c', name: 'Bob', createdAt: new Date(0) },
	]);
	await db.insert(schema.posts).values([
		{ id: 10, authorId: 1, title: 'first', views: 5 },
		{ id: 11, authorId: 1, title: 'second', views: 50 },
		{ id: 12, authorId: 2, title: 'third', views: 1 },
	]);
	await db.insert(schema.postTags).values([
		{ postId: 10, tag: 'sql' },
		{ postId: 10, tag: 'd1' },
	]);
});

describe('db.query', () => {
	it('finds rows with no config at all', async () => {
		const rows = await db.query.users.findMany();
		expect(rows.map((r) => r.email)).toEqual(['a@b.c', 'b@b.c']);
	});

	it('loads a one relation', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true, title: true },
			with: { author: true },
			orderBy: { id: 'asc' },
		});

		expect(rows[0]).toEqual({
			id: 10,
			title: 'first',
			author: {
				id: 1,
				email: 'a@b.c',
				name: 'Ada',
				role: 'member',
				active: true,
				settings: null,
				score: null,
				createdAt: new Date(0),
				updatedAt: null,
			},
		});
	});

	it('loads a many relation, including the empty case', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true, title: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, posts: [{ id: 10, title: 'first' }, { id: 11, title: 'second' }] },
			{ id: 2, posts: [{ id: 12, title: 'third' }] },
		]);
	});

	it('returns an empty array for a parent with no children', async () => {
		await db.delete(schema.posts).where(eq(schema.posts.authorId, 2)).run();
		const rows = await db.query.users.findMany({ columns: { id: true }, with: { posts: true } });
		expect(rows[1]).toEqual({ id: 2, posts: [] });
	});

	it('nests relations to arbitrary depth', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: {
				posts: {
					columns: { id: true },
					with: { tags: { columns: { tag: true }, orderBy: { tag: 'desc' } } },
				},
			},
			orderBy: { id: 'asc' },
		});

		expect(rows[0]).toEqual({
			id: 1,
			posts: [
				{ id: 10, tags: [{ tag: 'sql' }, { tag: 'd1' }] },
				{ id: 11, tags: [] },
			],
		});
	});

	it('does not leak the join keys it fetched for stitching', async () => {
		const rows = await db.query.users.findMany({
			columns: { name: true },
			with: { posts: { columns: { title: true } } },
		});

		expect(Object.keys(rows[0]!)).toEqual(['name', 'posts']);
		expect(Object.keys(rows[0]!.posts[0]!)).toEqual(['title']);
	});

	it('excludes columns marked false and keeps the rest', async () => {
		const [row] = await db.query.users.findMany({ columns: { settings: false, updatedAt: false } });
		expect(Object.keys(row!)).toEqual(['id', 'email', 'name', 'role', 'active', 'score', 'createdAt']);
	});

	it('filters, orders, limits and offsets', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			where: { views: { gt: 1 } },
			orderBy: { views: 'desc' },
			limit: 1,
			offset: 1,
		});

		expect(rows).toEqual([{ id: 10 }]);
	});

	it('filters children independently of parents', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, where: { views: { gt: 10 } } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [] }]);
	});

	it('pages a nested limit per parent, in one query rather than one per parent', async () => {
		const queries: string[] = [];
		const counted = drizzle({ client: DB, relations: schema.relations, onQuery: (e) => queries.push(e.sql) });

		const rows = await counted.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, orderBy: { id: 'desc' }, limit: 1 } },
			orderBy: { id: 'asc' },
		});

		// Each user keeps their own page — the whole point of the window.
		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [{ id: 12 }] }]);
		// Parents, then children. Fanning out per parent key would make this 3.
		expect(queries).toHaveLength(2);
		expect(queries[1]).toContain('row_number() over (partition by');
	});

	it('applies a nested offset per parent too', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			with: { posts: { columns: { id: true }, orderBy: { id: 'asc' }, offset: 1 } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [] }]);
	});

	it('computes extras, as a fragment and as a callback', async () => {
		const rows = await db.query.users.findMany({
			columns: { id: true },
			extras: {
				upper: sql<string>`upper(${schema.users.email})`,
				lower: (fields, { sql: tag }) => tag<string>`lower(${fields.email})`,
			},
			limit: 1,
		});
		expect(rows[0]).toEqual({ id: 1, upper: 'A@B.C', lower: 'a@b.c' });
	});

	it('decodes a nested extra the same way with and without a limit', async () => {
		// A nested limit routes the child through `row_number()`, so the extra
		// is read back out of a subquery alias. The alias has to carry the
		// expression's own decoder or the same query answers two ways.
		const config = {
			columns: { id: true },
			extras: { when: (fields: any, { max }: any) => max(fields.createdAt) },
		};
		const one = async (extra: object) =>
			(await db.query.posts.findFirst({
				columns: { id: true },
				with: { author: { ...config, ...extra } as never },
				orderBy: { id: 'asc' },
			})) as unknown as { author: { when: unknown } };

		expect((await one({})).author.when).toEqual(new Date(0));
		expect((await one({ limit: 1 })).author.when).toEqual(new Date(0));
	});

	it('does not leak the join key of a one relation past the projection', async () => {
		// `one` hands the parent a copy of the child row, and a copy taken
		// before the join columns are dropped keeps a column nobody asked for.
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			with: { author: { columns: { name: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows[0]).toEqual({ id: 10, author: { name: 'Ada' } });
	});

	it('findFirst returns one row or undefined', async () => {
		expect(await db.query.users.findFirst({ columns: { id: true } })).toEqual({ id: 1 });
		expect(await db.query.users.findFirst({ columns: { id: true }, where: { id: 99 } })).toBeUndefined();
	});

	it('is lazy and re-runnable', async () => {
		const q = db.query.users.findMany({ columns: { id: true } });
		expect(await q.execute()).toHaveLength(2);
		await db.delete(schema.users).where(eq(schema.users.id, 2)).run();
		expect(await q.execute()).toHaveLength(1);
	});

	it('names an unknown relation in its error', async () => {
		await expect(db.query.users.findMany({ with: { nope: true } as never }))
			.rejects.toThrow(/no relation named "nope"/);
	});

	it('accepts the binding-first form as well as the config object', async () => {
		const alt = drizzle(DB, { relations: schema.relations });
		expect(await alt.query.users.findFirst({ columns: { id: true } })).toEqual({ id: 1 });
	});

	it('keeps db.query and db._ through withSession', async () => {
		// The two headline features have to compose: a relational query served
		// from a read replica is the whole point of sessions. `withSession`
		// builds a fresh database, and used to hand back one with no `query`.
		const session = db.withSession('first-unconstrained');

		expect('query' in session).toBe(true);
		expect(session._.tableNamesMap).toMatchObject({ users: 'users' });
		expect(await session.query.users.findFirst({ columns: { id: true } })).toEqual({ id: 1 });
		expect(typeof session.bookmark).toBe('function');
	});

	it('gives each parent its own object for a shared one relation', async () => {
		// Posts 10 and 11 have the same author. Handing both the identical
		// object means mutating one result mutates the other, which Drizzle's
		// executor does not do.
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			with: { author: { columns: { id: true, name: true } } },
			orderBy: { id: 'asc' },
		});

		expect(rows[0]!.author).toEqual(rows[1]!.author);
		expect(rows[0]!.author).not.toBe(rows[1]!.author);

		rows[0]!.author.name = 'changed';
		expect(rows[1]!.author.name).toBe('Ada');
	});

	it('exposes drizzle-shaped metadata on db._', () => {
		expect(Object.keys(db._.relations)).toEqual(['users', 'posts', 'postTags']);
		// `schema` is the same object under the name other adapters look for.
		expect(db._.schema).toBe(db._.relations);
		expect(db._.tableNamesMap).toMatchObject({ users: 'users', post_tags: 'postTags' });
		expect(db._.relations['posts']!.relations['author']!.relationType).toBe('one');
		expect(db._.relations['users']!.relations['posts']!.relationType).toBe('many');
		expect(db._.fullSchema['users']).toBe(schema.users);
	});
});

describe('the filter DSL', () => {
	it('reads a bare scalar as eq', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { views: 50 } }))
			.toEqual([{ id: 11 }]);
	});

	it('applies every operator on a column as a conjunction', async () => {
		const rows = await db.query.posts.findMany({
			columns: { id: true },
			where: { views: { gte: 5, lt: 50 }, title: { like: 'fir%' } },
		});
		expect(rows).toEqual([{ id: 10 }]);
	});

	it('handles in / notIn', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { id: { in: [10, 12] } } }))
			.toEqual([{ id: 10 }, { id: 12 }]);
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { id: { notIn: [10, 12] } } }))
			.toEqual([{ id: 11 }]);
	});

	it('handles isNull, and reads isNull: false as no constraint', async () => {
		expect(await db.query.users.findMany({ columns: { id: true }, where: { score: { isNull: true } } }))
			.toHaveLength(2);
		expect(await db.query.users.findMany({ columns: { id: true }, where: { score: { isNotNull: true } } }))
			.toEqual([]);
		expect(await db.query.users.findMany({ columns: { id: true }, where: { score: { isNull: false } } }))
			.toHaveLength(2);
	});

	it('combines with AND, OR and NOT at the table level', async () => {
		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { OR: [{ views: 50 }, { title: 'third' }] },
				orderBy: { id: 'asc' },
			}),
		).toEqual([{ id: 11 }, { id: 12 }]);

		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { NOT: { views: { gt: 1 } } },
			}),
		).toEqual([{ id: 12 }]);

		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { AND: [{ views: { gt: 1 } }, { title: { like: 'sec%' } }] },
			}),
		).toEqual([{ id: 11 }]);
	});

	it('contributes nothing for an empty AND/OR, as Drizzle reads them', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { AND: [], OR: [] } }))
			.toHaveLength(3);
	});

	it('combines operators on a single column with NOT and OR', async () => {
		expect(await db.query.posts.findMany({ columns: { id: true }, where: { views: { NOT: { gt: 1 } } } }))
			.toEqual([{ id: 12 }]);
		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { views: { OR: [{ lt: 2 }, { gt: 40 }] } },
				orderBy: { id: 'asc' },
			}),
		).toEqual([{ id: 11 }, { id: 12 }]);
	});

	it('filters a parent by a relation, as a correlated exists', async () => {
		const queries: string[] = [];
		const counted = drizzle({ client: DB, relations: schema.relations, onQuery: (e) => queries.push(e.sql) });

		const rows = await counted.query.users.findMany({
			columns: { id: true },
			where: { posts: { views: { gt: 40 } } },
		});

		expect(rows).toEqual([{ id: 1 }]);
		// One query, not a pre-fetch of the children.
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain('exists (select 1 from');
	});

	it('reads true on a relation as "has any" and false as "has none"', async () => {
		await db.delete(schema.posts).where(eq(schema.posts.authorId, 2)).run();
		expect(await db.query.users.findMany({ columns: { id: true }, where: { posts: true } }))
			.toEqual([{ id: 1 }]);
		expect(await db.query.users.findMany({ columns: { id: true }, where: { posts: false } }))
			.toEqual([{ id: 2 }]);
	});

	it('nests a relation filter through two levels', async () => {
		expect(
			await db.query.users.findMany({ columns: { id: true }, where: { posts: { tags: { tag: 'sql' } } } }),
		).toEqual([{ id: 1 }]);
	});

	it('accepts a RAW fragment and a RAW callback', async () => {
		expect(
			await db.query.posts.findMany({ columns: { id: true }, where: { RAW: sql`${schema.posts.id} = 12` } }),
		).toEqual([{ id: 12 }]);

		expect(
			await db.query.posts.findMany({
				columns: { id: true },
				where: { RAW: (table, { eq: equals }) => equals((table as typeof schema.posts).id, 11) },
			}),
		).toEqual([{ id: 11 }]);
	});

	it('threads a placeholder through to execution rather than binding it early', async () => {
		// One query, re-executed with different values: the filter compiler has
		// to leave the slot unencoded rather than baking a value into the SQL.
		const query = db.query.posts.findMany({
			columns: { id: true },
			where: { id: { eq: ph<number>('wanted') } },
		});

		expect(await query.execute({ wanted: 12 })).toEqual([{ id: 12 }]);
		expect(await query.execute({ wanted: 11 })).toEqual([{ id: 11 }]);
	});

	it('supplies a placeholder to a child level as well as the parent', async () => {
		const rows = await db.query.users
			.findMany({
				columns: { id: true },
				with: { posts: { columns: { id: true }, where: { views: { gt: ph<number>('floor') } } } },
				orderBy: { id: 'asc' },
			})
			.execute({ floor: 10 });

		expect(rows).toEqual([{ id: 1, posts: [{ id: 11 }] }, { id: 2, posts: [] }]);
	});

	it('accepts a placeholder for a top-level limit and offset', async () => {
		const query = db.query.posts.findMany({
			columns: { id: true },
			orderBy: { id: 'asc' },
			limit: ph<number>('n'),
			offset: ph<number>('o'),
		});
		expect(await query.execute({ n: 2, o: 1 })).toEqual([{ id: 11 }, { id: 12 }]);
	});

	it('refuses a placeholder for a nested limit, naming why', async () => {
		// The per-parent page is a row_number() window whose bounds are part of
		// the SQL text, so a deferred value has nowhere to go.
		await expect(
			db.query.users.findMany({ with: { posts: { limit: ph<number>('n') } } }).execute({ n: 1 }),
		).rejects.toThrow(/cannot be a placeholder/);
	});

	it('says which placeholder was left unsupplied', async () => {
		await expect(
			db.query.posts.findMany({ where: { id: { eq: ph<number>('wanted') } } }).execute(),
		).rejects.toThrow(/No value supplied for placeholder "wanted"/);
	});

	it('refuses a Postgres array operator instead of mis-compiling it', async () => {
		await expect(
			db.query.posts.findMany({ where: { title: { arrayContains: ['x'] } } as never }),
		).rejects.toThrow(/Postgres array operator/);
	});

	it('names an unknown filter field', async () => {
		await expect(db.query.posts.findMany({ where: { nope: 1 } as never }))
			.rejects.toThrow(/Unknown filter field "nope"/);
	});
});

/**
 * A composite-key relation, which the main fixture does not have.
 *
 * A single-column key collapses to `inArray` and binds one parameter however
 * many parents there are. A composite one expands to `or(and(eq, eq), …)` —
 * one parameter per key column per parent — so it is the only shape that can
 * overrun D1's bound-parameter cap, and the only one that has to be chunked.
 */
describe('composite-key relations', () => {
	const regions = sqliteTable('regions', {
		country: text('country').notNull(),
		zone: integer('zone').notNull(),
		label: text('label'),
	}, (t) => [primaryKey({ columns: [t.country, t.zone] })]);

	const sites = sqliteTable('sites', {
		id: integer('id').primaryKey(),
		country: text('country').notNull(),
		zone: integer('zone').notNull(),
	});

	const compositeRelations = defineRelations({ regions, sites }, (r) => ({
		regions: { sites: r.many.sites() },
		sites: {
			region: r.one.regions({
				from: [r.sites.country, r.sites.zone],
				to: [r.regions.country, r.regions.zone],
			}),
		},
	}));

	const PARENTS = 24;

	beforeEach(async () => {
		for (const name of ['sites', 'regions']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema([regions, sites])) await DB.prepare(statement).run();

		const seed = drizzle({ client: DB, relations: compositeRelations });
		await seed.insert(regions).values(
			Array.from({ length: PARENTS }, (_, i) => ({ country: `c${i}`, zone: i, label: `l${i}` })),
		);
		await seed.insert(sites).values(
			Array.from({ length: PARENTS }, (_, i) => ({ id: i + 1, country: `c${i}`, zone: i })),
		);
	});

	it('chunks the child query instead of overrunning the parameter cap', async () => {
		// 24 parents × 2 key columns = 48 parameters; a cap of 10 stands in for
		// the real ~100 against the 60-parent case that reaches it.
		const queries: string[] = [];
		const counted = drizzle({
			client: DB,
			relations: compositeRelations,
			maxParams: 10,
			onQuery: (event) => queries.push(event.sql),
		});

		const rows = await counted.query.regions.findMany({
			columns: { country: true, zone: true },
			with: { sites: { columns: { id: true } } },
			orderBy: { zone: 'asc' },
		});

		// Every parent still gets its own child, across the chunk boundaries.
		expect(rows).toHaveLength(PARENTS);
		expect(rows.every((r) => r.sites.length === 1)).toBe(true);
		expect(rows[0]).toEqual({ country: 'c0', zone: 0, sites: [{ id: 1 }] });

		// One parent query, then several bounded child queries.
		expect(queries.length).toBeGreaterThan(2);
		expect(queries.slice(1).every((q) => q.includes('"country" = ?'))).toBe(true);
	});

	it('stays a single child query when the budget allows it', async () => {
		const queries: string[] = [];
		const counted = drizzle({
			client: DB,
			relations: compositeRelations,
			onQuery: (event) => queries.push(event.sql),
		});

		await counted.query.regions.findMany({ columns: { zone: true }, with: { sites: true } });
		expect(queries).toHaveLength(2);
	});
});

/**
 * Many-to-many, through a junction table.
 *
 * The target row carries nothing saying which parent it arrived by — the same
 * tag belongs to several articles — so the junction's own key is projected
 * alongside it and dropped once the buckets are built.
 */
describe('a many keyed on a non-unique column', () => {
	// The join key is `customerId`, not a primary key, so two orders by the same
	// customer resolve to the *same* bucket. That is legal and not rare, and it
	// is the only way the sharing shows up.
	const orders = sqliteTable('orders', {
		id: integer('id').primaryKey(),
		customerId: integer('customer_id').notNull(),
	});
	const shipments = sqliteTable('shipments', {
		id: integer('id').primaryKey(),
		customerId: integer('customer_id').notNull(),
	});

	const shipRelations = defineRelations({ orders, shipments }, (r) => ({
		orders: { shipments: r.many.shipments({ from: r.orders.customerId, to: r.shipments.customerId }) },
	}));

	const shipDb = drizzle({ client: DB, relations: shipRelations });

	beforeEach(async () => {
		for (const name of ['shipments', 'orders']) await DB.prepare(`drop table if exists "${name}"`).run();
		for (const statement of createSchema([orders, shipments])) await DB.prepare(statement).run();

		await shipDb.insert(orders).values([{ id: 1, customerId: 7 }, { id: 2, customerId: 7 }]);
		await shipDb.insert(shipments).values([{ id: 10, customerId: 7 }, { id: 11, customerId: 7 }]);
	});

	it('gives each parent its own array rather than sharing one', async () => {
		const rows = await shipDb.query.orders.findMany({ with: { shipments: true }, orderBy: { id: 'asc' } });

		expect(rows[0]!.shipments.map((s) => s.id)).toEqual([10, 11]);
		expect(rows[1]!.shipments.map((s) => s.id)).toEqual([10, 11]);

		// Both parents matched the same key. Sharing the array means appending to
		// one result silently appends to the other.
		expect(rows[0]!.shipments).not.toBe(rows[1]!.shipments);
		rows[0]!.shipments.push({ id: 99, customerId: 7 });
		expect(rows[1]!.shipments).toHaveLength(2);
	});

	it('gives each parent its own child objects too', async () => {
		const rows = await shipDb.query.orders.findMany({ with: { shipments: true }, orderBy: { id: 'asc' } });

		// Same rule one level down, and the same rule `one` already follows:
		// mutating a child of one parent must not mutate it for the other.
		expect(rows[0]!.shipments[0]).not.toBe(rows[1]!.shipments[0]);
		rows[0]!.shipments[0]!.customerId = 0;
		expect(rows[1]!.shipments[0]!.customerId).toBe(7);
	});
});

describe('many-to-many through a junction table', () => {
	const articles = sqliteTable('articles', {
		id: integer('id').primaryKey(),
		title: text('title').notNull(),
	});
	const tags = sqliteTable('tags', {
		id: integer('id').primaryKey(),
		label: text('label').notNull(),
	});
	const articleTags = sqliteTable('article_tags', {
		articleId: integer('article_id').notNull(),
		tagId: integer('tag_id').notNull(),
	}, (t) => [primaryKey({ columns: [t.articleId, t.tagId] })]);

	const m2m = defineRelations({ articles, tags, articleTags }, (r) => ({
		articles: {
			tags: r.many.tags({
				from: r.articles.id.through(r.articleTags.articleId),
				to: r.tags.id.through(r.articleTags.tagId),
			}),
		},
		tags: { articles: r.many.articles() },
	}));

	const m2mDb = drizzle({ client: DB, relations: m2m });

	beforeEach(async () => {
		for (const name of ['article_tags', 'tags', 'articles']) {
			await DB.prepare(`drop table if exists "${name}"`).run();
		}
		for (const statement of createSchema([articles, tags, articleTags])) await DB.prepare(statement).run();

		await m2mDb.insert(articles).values([{ id: 1, title: 'one' }, { id: 2, title: 'two' }]);
		await m2mDb.insert(tags).values([{ id: 100, label: 'sql' }, { id: 200, label: 'd1' }]);
		await m2mDb.insert(articleTags).values([
			{ articleId: 1, tagId: 100 },
			{ articleId: 1, tagId: 200 },
			{ articleId: 2, tagId: 100 },
		]);
	});

	it('loads each parent’s targets, sharing a target across parents', async () => {
		const rows = await m2mDb.query.articles.findMany({
			columns: { id: true },
			with: { tags: { columns: { label: true }, orderBy: { label: 'asc' } } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, tags: [{ label: 'd1' }, { label: 'sql' }] },
			{ id: 2, tags: [{ label: 'sql' }] },
		]);
	});

	it('does not leak the junction key it projected for stitching', async () => {
		const rows = await m2mDb.query.articles.findMany({ columns: { id: true }, with: { tags: true } });
		expect(Object.keys(rows[0]!.tags[0]!)).toEqual(['id', 'label']);
	});

	it('traverses in the other direction too', async () => {
		const rows = await m2mDb.query.tags.findMany({
			columns: { label: true },
			with: { articles: { columns: { title: true }, orderBy: { title: 'asc' } } },
			orderBy: { label: 'asc' },
		});

		expect(rows).toEqual([
			{ label: 'd1', articles: [{ title: 'one' }] },
			{ label: 'sql', articles: [{ title: 'one' }, { title: 'two' }] },
		]);
	});

	it('pages a many-to-many per parent', async () => {
		const rows = await m2mDb.query.articles.findMany({
			columns: { id: true },
			with: { tags: { columns: { label: true }, orderBy: { label: 'asc' }, limit: 1 } },
			orderBy: { id: 'asc' },
		});

		expect(rows).toEqual([
			{ id: 1, tags: [{ label: 'd1' }] },
			{ id: 2, tags: [{ label: 'sql' }] },
		]);
	});

	it('filters a parent by a many-to-many relation', async () => {
		const rows = await m2mDb.query.articles.findMany({
			columns: { id: true },
			where: { tags: { label: 'd1' } },
		});
		expect(rows).toEqual([{ id: 1 }]);
	});
});
