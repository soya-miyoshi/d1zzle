/**
 * `getTableConfig` in Drizzle v1's shape.
 *
 * The reason this matters is at the bottom of the file: Pothos' drizzle plugin
 * resolves every model's primary key through a three-step fallback over exactly
 * these fields, and throws if all three miss. Before this shape existed, a
 * composite-key table missed all three.
 */
import { describe, expect, it } from 'vitest';
import type { Column } from '../../src/index.js';
import { getTableConfig, integer, sqliteTable, text, unique } from '../../src/index.js';
import { postTags, posts, users } from '../schema.js';

const names = (columns: readonly Column<any>[]) => columns.map((c) => c.name);

describe('the v1 field set', () => {
	it('reports the table name and a schema of undefined', () => {
		const config = getTableConfig(users);
		expect(config.name).toBe('users');
		expect(config.schema).toBeUndefined();
	});

	it('lists every column', () => {
		expect(names(getTableConfig(posts).columns)).toEqual(['id', 'author_id', 'title', 'views']);
	});

	it('reports a composite primary key, which Drizzle’s own version leaves empty', () => {
		const [pk, ...rest] = getTableConfig(postTags).primaryKeys;
		expect(rest).toEqual([]);
		expect(names(pk!.columns)).toEqual(['post_id', 'tag']);
		expect(pk!.name).toBe('post_tags_pk');
		expect(pk!.table).toBe(postTags);
	});

	it('reports a table-level unique() constraint', () => {
		const [uq] = getTableConfig(postTags).uniqueConstraints;
		expect(uq!.name).toBe('post_tags_tag_unique');
		expect(names(uq!.columns)).toEqual(['tag']);
	});

	it('leaves a column-level .unique() on the column, as Drizzle does', () => {
		const config = getTableConfig(users);
		expect(config.uniqueConstraints).toEqual([]);
		expect(config.columns.find((c) => c.name === 'email')!.isUnique).toBe(true);
	});

	it('reports indexes with their derived names and partial predicates', () => {
		const indexes = getTableConfig(users).indexes;
		expect(indexes.map((i) => i.name)).toEqual(['users_name_idx', 'users_email_active_idx']);
		expect(indexes.find((i) => i.unique)!.where).toBeDefined();
	});

	it('derives an index name the same way the DDL does', () => {
		const t = sqliteTable('t', { a: integer('a') }, () => []);
		expect(getTableConfig(t).indexes).toEqual([]);
		const named = sqliteTable('u', { a: integer('a'), b: text('b') }, (c) => [unique().on(c.a, c.b)]);
		expect(getTableConfig(named).uniqueConstraints[0]!.name).toBe('u_a_b_unique');
	});

	it('reports checks', () => {
		const [check] = getTableConfig(users).checks;
		expect(check!.name).toBe('users_score_check');
		expect(check!.value).toBeDefined();
	});

	it('folds inline .references() into foreignKeys alongside table-level ones', () => {
		// `posts.authorId` is declared with `.references(() => users.id)`.
		const [inline] = getTableConfig(posts).foreignKeys;
		expect(names(inline!.columns)).toEqual(['author_id']);
		expect(names(inline!.foreignColumns)).toEqual(['id']);
		expect(inline!.foreignTable).toBe(users);
		expect(inline!.onDelete).toBe('cascade');

		const [tableLevel] = getTableConfig(postTags).foreignKeys;
		expect(names(tableLevel!.columns)).toEqual(['post_id']);
		expect(tableLevel!.foreignTable).toBe(posts);
		expect(tableLevel!.onDelete).toBe('cascade');
	});
});

describe('Pothos’ getPrimaryKey fallback chain resolves for every fixture table', () => {
	/** Copied from `@pothos/plugin-drizzle`'s `utils/config.ts`, verbatim. */
	const getPrimaryKey = (table: Parameters<typeof getTableConfig>[0]): Column<any>[] => {
		const tableConfig = getTableConfig(table);
		const primaryKey = tableConfig.columns.find((column) => column.primary);
		if (primaryKey) return [primaryKey];
		const primaryKeys = tableConfig.primaryKeys.find((key) => key.columns.length > 0);
		if (primaryKeys) return [...primaryKeys.columns];
		const uniqueColumn = tableConfig.columns.find((column) => column.isUnique);
		if (uniqueColumn) return [uniqueColumn];
		throw new Error('Could not find primary key');
	};

	it('takes a column-level primary key first', () => {
		expect(names(getPrimaryKey(users))).toEqual(['id']);
		expect(names(getPrimaryKey(posts))).toEqual(['id']);
	});

	it('falls through to the composite key — the case that used to throw', () => {
		expect(names(getPrimaryKey(postTags))).toEqual(['post_id', 'tag']);
	});

	it('falls through again to a unique column when there is no primary key', () => {
		const sessions = sqliteTable('sessions', {
			token: text('token').notNull().unique(),
			userId: integer('user_id').notNull(),
		});
		expect(names(getPrimaryKey(sessions))).toEqual(['token']);
	});

	it('throws with a clear message when a table has no key of any kind', () => {
		const events = sqliteTable('events', { kind: text('kind'), at: integer('at') });
		expect(() => getPrimaryKey(events)).toThrow('Could not find primary key');
	});
});
