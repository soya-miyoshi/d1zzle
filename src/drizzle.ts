/**
 * `d1zzle/drizzle` — the type-level bridge to Drizzle's own types.
 *
 * At runtime a d1zzle schema already *is* a Drizzle schema: the entity kinds,
 * the symbols and the column surface all match, and `drizzle-orm`'s `is()`,
 * `getTableColumns()` and `getTableName()` work on it unchanged
 * (see `schema/drizzle-entity.ts`).
 *
 * The types cannot be made assignable the same way. Drizzle's `Column` class
 * declares a `protected config`, and TypeScript only considers a protected
 * member compatible when both types originate from the same declaration — so
 * no independent class can ever be assignable to it. That is a language rule,
 * not something a different phantom shape could work around.
 *
 * This module closes the gap with a cast whose *output* type is computed from
 * the metadata each column already carries, so an adapter typed against
 * `drizzle-orm` accepts our schema and infers exactly the same row types:
 *
 * ```ts
 * import { asDrizzleSchema } from 'd1zzle/drizzle';
 * import { buildSchema } from 'drizzle-graphql';
 *
 * const graphql = buildSchema(db as never, { schema: asDrizzleSchema(schema) });
 * ```
 *
 * `drizzle-orm` is an optional peer. Everything here except `asDrizzleRelations`
 * imports only its types and contributes nothing at runtime; that one function
 * needs Drizzle's `One`/`Many` classes themselves, for the reason documented on
 * it. Nothing outside this module imports `drizzle-orm` at all, so a project
 * that never touches an adapter never loads it.
 */
import { Many as DrizzleMany, One as DrizzleOne } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';
import type { Column, ColumnMeta } from './schema/columns.js';
import type { ToDrizzleDataType } from './schema/drizzle-entity.js';
import type { TableRelationalConfig } from './relations/define.js';
import type { ColumnsMap, NameOf, Table, TableColumns } from './schema/table.js';

type ColumnsOf<T> = T extends { [TableColumns]: infer C extends ColumnsMap } ? C : never;

/** One of our columns, expressed as the Drizzle column it behaves like. */
export type ToDrizzleColumn<C, TTableName extends string, TKey extends string> = C extends
	Column<infer M extends ColumnMeta> ? SQLiteColumn<{
		name: TKey;
		tableName: TTableName;
		dataType: ToDrizzleDataType<M['dataType']>;
		data: M['data'];
		driverParam: M['driverParam'];
		notNull: M['notNull'] extends true ? true : false;
		hasDefault: M['hasDefault'] extends true ? true : false;
		isPrimaryKey: boolean;
		isAutoincrement: boolean;
		hasRuntimeDefault: boolean;
		enumValues: M['enumValues'] extends readonly string[] ? [...M['enumValues']] : undefined;
		// Both are pinned to `undefined`, never `M['generated']`. Drizzle's
		// `OptionalKeyOnly` drops any column whose `generated` is set, which
		// would take every defaultable column out of the inferred insert model.
		// Generated columns are excluded from ours by `InferInsert` instead.
		generated: undefined;
		identity: undefined;
	}>
	: never;

export type ToDrizzleTable<T> = T extends Table ? SQLiteTableWithColumns<{
		name: NameOf<T>;
		schema: undefined;
		dialect: 'sqlite';
		columns: {
			[K in keyof ColumnsOf<T> & string]: ToDrizzleColumn<ColumnsOf<T>[K], NameOf<T>, K>;
		};
	}>
	: T;

export type ToDrizzleSchema<TSchema> = { [K in keyof TSchema]: ToDrizzleTable<TSchema[K]> };

/**
 * Re-type a schema module as Drizzle's. Identity at runtime — the objects
 * already satisfy every check Drizzle makes of them.
 */
export const asDrizzleSchema = <TSchema extends Record<string, unknown>>(
	schema: TSchema,
): ToDrizzleSchema<TSchema> => schema as unknown as ToDrizzleSchema<TSchema>;

/** Re-type a single table. */
export const asDrizzleTable = <T extends Table>(t: T): ToDrizzleTable<T> =>
	t as unknown as ToDrizzleTable<T>;

/**
 * Re-prototype a `defineRelations` result onto Drizzle's `One`/`Many` classes.
 *
 * Needed by `@pothos/plugin-drizzle`, and by nothing else so far. The plugin is
 * duck-typed everywhere but one line, where it decides whether a relation field
 * is a GraphQL list:
 *
 * ```js
 * type: relationField instanceof Many ? [ref] : ref
 * ```
 *
 * That is a bare `instanceof`, not the `is()`/`entityKind` walk the rest of the
 * ecosystem uses, and `instanceof` consults the *right-hand* constructor — so
 * no amount of matching `entityKind` on our side can satisfy it. Without this,
 * every `many` relation silently resolves as a single object instead of a list.
 *
 * Each relation becomes a shallow copy whose prototype is Drizzle's, so it
 * carries every field the plugin reads (`targetTableName`, `sourceColumns`,
 * `targetColumns`) *and* answers `instanceof` correctly. The originals are
 * untouched: `db._.relations` and the query executor keep working on ours.
 *
 * This is the one function in this module with a runtime cost — it is why
 * `drizzle-orm` has to be installed to call it, which anyone using an adapter
 * already does.
 */
export function asDrizzleRelations<TRelations extends Record<string, unknown>>(relations: TRelations): TRelations {
	const adapted: Record<string, unknown> = {};

	for (const [tsName, entry] of Object.entries(relations as Record<string, TableRelationalConfig>)) {
		const rebuilt: Record<string, unknown> = {};
		for (const [name, relation] of Object.entries(entry.relations)) {
			const prototype = (relation.relationType === 'many' ? DrizzleMany : DrizzleOne).prototype;
			rebuilt[name] = Object.assign(Object.create(prototype), relation);
		}
		adapted[tsName] = { ...entry, relations: rebuilt };
	}

	return adapted as TRelations;
}
