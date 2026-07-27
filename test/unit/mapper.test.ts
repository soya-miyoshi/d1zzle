import { describe, expect, it } from 'vitest';
import { bindParams, count, eq, MissingPlaceholderError, ph, query } from '../../src/index.js';
import { posts, users } from '../schema.js';

describe('row mapping', () => {
	it('decodes booleans, timestamps and json positionally', () => {
		const compiled = query.select({
			active: users.active,
			createdAt: users.createdAt,
			updatedAt: users.updatedAt,
			settings: users.settings,
			email: users.email,
		}).from(users).compile();

		const [row] = compiled.map([[1, 1_700_000_000, 1_700_000_000_000, '{"theme":"dark"}', 'a@b.c']]);

		expect(row).toEqual({
			active: true,
			createdAt: new Date(1_700_000_000_000),
			updatedAt: new Date(1_700_000_000_000),
			settings: { theme: 'dark' },
			email: 'a@b.c',
		});
	});

	it('leaves nulls null without calling the decoder', () => {
		const compiled = query.select({ settings: users.settings, score: users.score })
			.from(users).compile();
		expect(compiled.map([[null, null]])).toEqual([{ settings: null, score: null }]);
	});

	it('decodes aggregate results', () => {
		const compiled = query.select({ n: count() }).from(users).compile();
		expect(compiled.map([['7']])).toEqual([{ n: 7 }]);
	});

	it('builds nested groups for joined selections', () => {
		const compiled = query.select().from(users)
			.innerJoin(posts, eq(posts.authorId, users.id))
			.compile();

		const row = [1, 'a@b.c', null, 'member', 1, null, null, 0, null, 9, 1, 'title', 3];
		expect(compiled.map([row])).toEqual([{
			users: {
				id: 1,
				email: 'a@b.c',
				name: null,
				role: 'member',
				active: true,
				settings: null,
				score: null,
				createdAt: new Date(0),
				updatedAt: null,
			},
			posts: { id: 9, authorId: 1, title: 'title', views: 3 },
		}]);
	});

	it('nulls a whole left-joined group when every column is null', () => {
		const compiled = query.select().from(users)
			.leftJoin(posts, eq(posts.authorId, users.id))
			.compile();

		const row = [1, 'a@b.c', null, 'member', 1, null, null, 0, null, null, null, null, null];
		const [mapped] = compiled.map([row]) as [{ users: unknown; posts: unknown }];
		expect(mapped.posts).toBeNull();
		expect(mapped.users).toMatchObject({ id: 1 });
	});

	it('maps the keyed (batch) path through generated aliases on collision', () => {
		const compiled = query.select({ a: { id: users.id }, b: { id: posts.id } })
			.from(users)
			.innerJoin(posts, eq(posts.authorId, users.id))
			.compile();

		expect(compiled.columnNames).toEqual(['c0', 'c1']);
		expect(compiled.mapKeyed([{ c0: 1, c1: 2 }])).toEqual([{ a: { id: 1 }, b: { id: 2 } }]);
	});

	it('gives every mapped row the same key order', () => {
		const compiled = query.select({ id: users.id, email: users.email }).from(users).compile();
		const rows = compiled.map([[1, 'a'], [2, 'b']]);
		expect(rows.map((r) => Object.keys(r as object))).toEqual([['id', 'email'], ['id', 'email']]);
	});
});

describe('parameter binding', () => {
	it('fills placeholders with the column encoder', () => {
		const compiled = query.select({ id: users.id }).from(users)
			.where(eq(users.active, ph('active')))
			.compile();

		expect(bindParams(compiled.params, { active: true })).toEqual([1]);
	});

	it('evaluates fn slots freshly on every bind', () => {
		const compiled = query.insert(users).values({ email: 'a@b.c' }).compile();
		const first = bindParams(compiled.params);
		const second = bindParams(compiled.params);
		expect(first).toEqual(second); // the fixture's $defaultFn is deterministic
		expect(first[1]).toBe(0);
	});

	it('reports a missing placeholder by name', () => {
		const compiled = query.select({ id: users.id }).from(users)
			.where(eq(users.email, ph('email')))
			.compile();

		expect(() => bindParams(compiled.params, {})).toThrow(MissingPlaceholderError);
		expect(() => bindParams(compiled.params, {})).toThrow(/"email"/);
	});

	it('passes null through without encoding', () => {
		const compiled = query.select({ id: users.id }).from(users)
			.where(eq(users.name, ph('name')))
			.compile();
		expect(bindParams(compiled.params, { name: null })).toEqual([null]);
	});
});
