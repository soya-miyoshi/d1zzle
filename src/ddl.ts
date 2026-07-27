/**
 * Schema → DDL. A separate entry point: the core query builder never reaches
 * this module, so it costs the Worker bundle nothing (rule R5).
 *
 * `d1zzle-migrate` generates migrations from exactly these strings, which is what
 * keeps "what the schema says" and "what the migration does" in one place.
 */
import type { Column } from './schema/columns.js';
import { isColumn } from './schema/columns.js';
import type { CheckMeta, ForeignKeyMeta, IndexMeta, PrimaryKeyConstraint, PrimaryKeyMeta, UniqueMeta } from './schema/constraints.js';
import { foreignKeyName, indexName, primaryKeyName, uniqueConstraintName } from './schema/constraints.js';

/** Re-exported: the derivation moved to `schema/constraints.ts`, which
 * `getTableConfig` also reads, so the two cannot report different names. */
export { foreignKeyName, indexName, primaryKeyName, uniqueConstraintName } from './schema/constraints.js';
import type { Table } from './schema/table.js';
import { getTableColumns, getTableExtras, getTableName } from './schema/table.js';
import type { RenderContext, SQLChunk } from './sql/sql.js';
import { defaultRenderContext, quoteIdentifier, render } from './sql/sql.js';

/**
 * Rendered in place of a bound value while building DDL. A literal `?` is
 * perfectly legal inside a check constraint or a partial-index predicate built
 * from `sql.raw(…)`, so parameter slots are marked with something that cannot
 * appear in SQL text instead of being recovered by counting `?`s afterwards.
 */
const PARAM_TOKEN = '\u0000d1zzle:param\u0000';

/** DDL cannot qualify column names with a table, and cannot bind parameters. */
const ddlContext: RenderContext = { ...defaultRenderContext, bareColumns: true, paramToken: PARAM_TOKEN };

export interface DDLOptions {
	/** `create table if not exists` — and, for `dropTable`, `if exists`. */
	readonly ifNotExists?: boolean;
	/** `drop table if exists`. Clearer than `ifNotExists` on a drop, which
	 * reads as the opposite of what it does; both are accepted. */
	readonly ifExists?: boolean;
	/** Emit `STRICT`; D1 supports it and it catches type mistakes early. */
	readonly strict?: boolean;
}

/**
 * Render a fragment with its parameters inlined — DDL cannot bind values.
 *
 * The literal replaces the token exactly, with no padding of its own. It used
 * to be surrounded by spaces, which meant `${c.active} = ${1}` rendered as
 * `"active" =  1 ` — the template's own space, then the added one, then a
 * trailing one. Introspection reads that predicate back from SQLite trimmed
 * and single-spaced, so a partial index or check built with an interpolated
 * value never compared equal to itself and `check` and `push` re-emitted it on
 * every run.
 */
export const renderInline = (chunk: SQLChunk | string): string => {
	if (typeof chunk === 'string') return chunk;
	const { sql, params } = render(chunk, ddlContext);
	let index = 0;
	return sql.replaceAll(PARAM_TOKEN, () => {
		const slot = params[index++];
		if (!slot || slot.k !== 'const') return 'null';
		return literal(slot.v);
	});
};

export const literal = (value: unknown): string => {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'bigint') return value.toString();
	return `'${String(value).replaceAll("'", "''")}'`;
};

const typeName = (column: Column<any>): string => column.config.type;

const referenceClause = (column: Column<any>): string => {
	const reference = column.config.references;
	if (!reference) return '';
	const target = reference.ref();
	let clause = ` references ${quoteIdentifier(target.tableName)}(${quoteIdentifier(target.name)})`;
	if (reference.onDelete) clause += ` on delete ${reference.onDelete}`;
	if (reference.onUpdate) clause += ` on update ${reference.onUpdate}`;
	return clause;
};

/**
 * The one spelling of a default that SQLite accepts everywhere.
 *
 * `CREATE TABLE` requires an expression default to be parenthesised —
 * `default (unixepoch())` — while `pragma table_info` reports it with the
 * parens stripped. Both spellings therefore circulate, and the bare one is
 * poison: it is a syntax error in `create table` and in `add column`, and
 * because "does it start with `(`" is also how the kit decides whether a
 * default is a constant, the bare form talks its way onto the `ADD COLUMN`
 * path that the check exists to keep it off. Normalising here — at the single
 * point where a `sql` default becomes text — makes every emission site and
 * that check right at once. Only a bare literal (and `CURRENT_*`, legal
 * unparenthesised) is left alone.
 */
export const defaultExpression = (value: string): string => {
	const text = value.trim();
	if (text.startsWith('(')) return text;
	if (/^current_(timestamp|date|time)$/i.test(text)) return text;
	if (/^(null|true|false)$/i.test(text)) return text;
	// A number, with the optional sign and exponent SQLite allows.
	if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return text;
	if (/^0x[0-9a-f]+$/i.test(text)) return text;
	// One whole string or blob literal — not `'a' || 'b'`, which is an expression.
	if (/^x?'(?:[^']|'')*'$/i.test(text)) return text;
	return `(${text})`;
};

const defaultClause = (column: Column<any>): string => {
	const value = column.config.default;
	if (!value) return '';
	if (value.kind === 'sql') return ` default ${defaultExpression(renderInline(value.value as SQLChunk))}`;
	return ` default ${literal(column.config.encode(value.value))}`;
};

/** One `column-def`, in SQLite's constraint order. */
export const columnDDL = (column: Column<any>, inlinePrimaryKey: boolean): string => {
	let ddl = `${quoteIdentifier(column.name)} ${typeName(column)}`;

	if (inlinePrimaryKey && column.config.primaryKey) {
		ddl += ' primary key';
		if (column.config.autoIncrement) ddl += ' autoincrement';
	}
	if (column.config.notNull) ddl += ' not null';
	if (column.config.unique) ddl += ' unique';
	if (column.config.generated) {
		ddl += ` generated always as (${renderInline(column.config.generated.as)}) ${column.config.generated.mode}`;
	}
	ddl += defaultClause(column);
	ddl += referenceClause(column);

	return ddl;
};

const constraintName = (name: string): string => `constraint ${quoteIdentifier(name)} `;

export const primaryKeyDDL = (meta: PrimaryKeyMeta, tableName: string): string =>
	`${constraintName(primaryKeyName(meta, tableName))}primary key (${
		meta.columns.map((c) => quoteIdentifier(c.name)).join(', ')
	})`;

export const uniqueDDL = (meta: UniqueMeta, tableName: string): string =>
	`${constraintName(uniqueConstraintName(meta, tableName))}unique (${
		meta.columns.map((c) => quoteIdentifier(c.name)).join(', ')
	})`;

export const foreignKeyDDL = (meta: ForeignKeyMeta, tableName: string): string => {
	const target = meta.foreignColumns[0];
	if (!target) throw new Error(`Foreign key on "${tableName}" has no target columns.`);
	let ddl = `${constraintName(foreignKeyName(meta, tableName))}foreign key (${
		meta.columns.map((c) => quoteIdentifier(c.name)).join(', ')
	}) references ${quoteIdentifier(target.tableName)}(${
		meta.foreignColumns.map((c) => quoteIdentifier(c.name)).join(', ')
	})`;
	if (meta.onDelete) ddl += ` on delete ${meta.onDelete}`;
	if (meta.onUpdate) ddl += ` on update ${meta.onUpdate}`;
	return ddl;
};

export const checkDDL = (meta: CheckMeta): string =>
	`${constraintName(meta.name)}check (${renderInline(meta.value)})`;

export const createIndex = (meta: IndexMeta, tableName: string, options: DDLOptions = {}): string => {
	const columns = meta.columns.map((c) => (isColumn(c) ? quoteIdentifier(c.name) : renderInline(c))).join(', ');
	let ddl = `create ${meta.unique ? 'unique ' : ''}index ${options.ifNotExists ? 'if not exists ' : ''}${
		quoteIdentifier(indexName(meta, tableName))
	} on ${quoteIdentifier(tableName)} (${columns})`;
	if (meta.where) ddl += ` where ${renderInline(meta.where)}`;
	return ddl;
};

/** `CREATE TABLE` for one table, excluding its indexes. */
export function createTable(t: Table, options: DDLOptions = {}): string {
	const name = getTableName(t);
	const columns = Object.values(getTableColumns(t)) as Column<any>[];
	const extras = getTableExtras(t);
	const compositePk = extras.find((e): e is PrimaryKeyConstraint => e.kind === 'primaryKey');

	const parts: string[] = columns.map((column) => columnDDL(column, compositePk === undefined));

	if (compositePk) parts.push(primaryKeyDDL(compositePk.meta, name));
	for (const extra of extras) {
		if (extra.kind === 'unique') parts.push(uniqueDDL(extra.meta, name));
		if (extra.kind === 'foreignKey') parts.push(foreignKeyDDL(extra.meta, name));
		if (extra.kind === 'check') parts.push(checkDDL(extra.meta));
	}

	const body = parts.map((p) => `\t${p}`).join(',\n');
	return `create table ${options.ifNotExists ? 'if not exists ' : ''}${quoteIdentifier(name)} (\n${body}\n)${
		options.strict ? ' strict' : ''
	}`;
}

export const createIndexes = (t: Table, options: DDLOptions = {}): string[] =>
	getTableExtras(t)
		.filter((e) => e.kind === 'index')
		.map((builder) => createIndex(builder.meta, getTableName(t), options));

export const dropTable = (t: Table, options: DDLOptions = {}): string =>
	`drop table ${options.ifExists ?? options.ifNotExists ? 'if exists ' : ''}${
		quoteIdentifier(getTableName(t))
	}`;

/** Every statement needed to create a whole schema, tables before indexes. */
export function createSchema(tables: readonly Table[], options: DDLOptions = {}): string[] {
	const statements = tables.map((t) => createTable(t, options));
	for (const t of tables) statements.push(...createIndexes(t, options));
	return statements;
}
