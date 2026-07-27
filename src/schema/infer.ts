import type { Column, ColumnMeta } from './columns.js';
import type { ColumnsMap, Table, TableColumns } from './table.js';

/** Prettify — applied only at the public boundary, never internally. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type Cols<T extends Table> = T[typeof TableColumns];

/** The decoded type of a column, widened by nullability. */
export type Out<C> = C extends Column<infer M extends ColumnMeta>
	? M['notNull'] extends true ? M['data'] : M['data'] | null
	: never;

export type InferSelectFromColumns<C extends ColumnsMap> = Simplify<{ [K in keyof C]: Out<C[K]> }>;

export type InferSelect<T extends Table> = InferSelectFromColumns<Cols<T>>;

/** A column is required on insert only when it is notNull and has no default. */
type RequiredKeys<C> = {
	[K in keyof C]: C[K] extends Column<infer M extends ColumnMeta>
		? M['notNull'] extends true ? (M['hasDefault'] extends true ? never : K) : never
		: never;
}[keyof C];

/**
 * `generatedAlwaysAs()` columns are computed by SQLite and rejected outright by
 * an `insert`, so they are absent from the insert model rather than optional —
 * matching Drizzle, and making the invalid statement unwritable.
 */
type GeneratedKeys<C> = {
	[K in keyof C]: C[K] extends Column<infer M extends ColumnMeta> ? (M['generated'] extends true ? K : never)
		: never;
}[keyof C];

type Writable<C> = Exclude<keyof C, GeneratedKeys<C>>;

export type InferInsertFromColumns<C extends ColumnsMap> = Simplify<
	& { [K in Exclude<RequiredKeys<C>, GeneratedKeys<C>>]: Out<C[K]> }
	& { [K in Exclude<Writable<C>, RequiredKeys<C>>]?: Out<C[K]> }
>;

export type InferInsert<T extends Table> = InferInsertFromColumns<Cols<T>>;

/** Drizzle-compatible aliases. */
export type InferSelectModel<T extends Table> = InferSelect<T>;
export type InferInsertModel<T extends Table> = InferInsert<T>;
