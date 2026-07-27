/**
 * The promise this suite protects: a d1zzle schema is indistinguishable from a
 * Drizzle schema to Drizzle's *own* code. Everything imported below comes from
 * the real `drizzle-orm` package (a devDependency — never a runtime one), and
 * is handed objects built by d1zzle.
 */
import { getTableColumns as drizzleGetTableColumns, getTableName as drizzleGetTableName, is } from 'drizzle-orm';
import { Column as DrizzleColumn, Table as DrizzleTable } from 'drizzle-orm';
import { SQLiteColumn, SQLiteInteger, SQLiteTable, SQLiteText } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { alias, blob, integer, sqliteTable, text } from '../../src/index.js';
import { postTags, posts, users } from '../schema.js';

describe('drizzle entity recognition', () => {
	it('recognises our tables as SQLite tables', () => {
		expect(is(users, SQLiteTable)).toBe(true);
		expect(is(users, DrizzleTable)).toBe(true);
		expect(is(posts, SQLiteTable)).toBe(true);
		expect(is(postTags, SQLiteTable)).toBe(true);
	});

	it('recognises our columns, down to the concrete column class', () => {
		expect(is(users.id, DrizzleColumn)).toBe(true);
		expect(is(users.id, SQLiteColumn)).toBe(true);
		expect(is(users.id, SQLiteInteger)).toBe(true);
		expect(is(users.email, SQLiteText)).toBe(true);
		// drizzle-graphql uses exactly this check to decide whether a primary
		// key is auto-generated and can be omitted from insert mutations.
		expect(is(users.email, SQLiteInteger)).toBe(false);
	});

	it('does not claim to be something it is not', () => {
		expect(is({}, SQLiteTable)).toBe(false);
		expect(is(users.id, SQLiteTable)).toBe(false);
	});

	it('answers drizzle-orm’s own accessors', () => {
		expect(drizzleGetTableName(users as never)).toBe('users');
		expect(Object.keys(drizzleGetTableColumns(users as never))).toEqual([
			'id',
			'email',
			'name',
			'role',
			'active',
			'settings',
			'score',
			'createdAt',
			'updatedAt',
		]);
	});

	it('reports an alias the way drizzle does', () => {
		const author = alias(users, 'author');
		expect(drizzleGetTableName(author as never)).toBe('author');
		expect(is(author, SQLiteTable)).toBe(true);
	});
});

describe('the column surface adapters read', () => {
	it('exposes dataType, columnType and the SQL type', () => {
		expect(users.id).toMatchObject({ dataType: 'number', columnType: 'SQLiteInteger', primary: true });
		expect(users.email).toMatchObject({ dataType: 'string', columnType: 'SQLiteText', notNull: true });
		expect(users.active).toMatchObject({ dataType: 'boolean', columnType: 'SQLiteBoolean' });
		expect(users.createdAt).toMatchObject({ dataType: 'date', columnType: 'SQLiteTimestamp' });
		expect(users.settings).toMatchObject({ dataType: 'json', columnType: 'SQLiteTextJson' });
		expect(users.id.getSQLType()).toBe('integer');
		expect(users.active.getSQLType()).toBe('integer');
	});

	it('classifies every blob mode', () => {
		const t = sqliteTable('t', {
			bytes: blob('bytes'),
			payload: blob('payload', { mode: 'json' }),
			big: blob('big', { mode: 'bigint' }),
		});

		expect(t.bytes).toMatchObject({ dataType: 'buffer', columnType: 'SQLiteBlobBuffer' });
		expect(t.payload).toMatchObject({ dataType: 'json', columnType: 'SQLiteBlobJson' });
		expect(t.big).toMatchObject({ dataType: 'bigint', columnType: 'SQLiteBigInt' });
	});

	it('exposes enum values, defaults and uniqueness', () => {
		expect(users.role.enumValues).toEqual(['admin', 'member']);
		expect(users.role.hasDefault).toBe(true);
		expect(users.role.default).toBe('member');
		expect(users.email.isUnique).toBe(true);
		expect(users.name.hasDefault).toBe(false);
	});

	it('maps values in both directions', () => {
		expect(users.active.mapToDriverValue(true)).toBe(1);
		expect(users.active.mapFromDriverValue(1)).toBe(true);
		expect(users.createdAt.mapToDriverValue(new Date(2000))).toBe(2);
		expect(users.createdAt.mapFromDriverValue(2)).toEqual(new Date(2000));
		expect(users.email.mapFromDriverValue(null)).toBeNull();
	});

	it('links each column back to its table', () => {
		expect(drizzleGetTableName(users.id.table as never)).toBe('users');
	});

	it('keeps the property key when no database name is given', () => {
		const t = sqliteTable('t', { camelCase: text(), named: integer('explicit_name') });
		expect(t.camelCase.name).toBe('camelCase');
		expect(t.camelCase.keyAsName).toBe(true);
		expect(t.named.name).toBe('explicit_name');
		expect(t.named.keyAsName).toBe(false);
	});
});
