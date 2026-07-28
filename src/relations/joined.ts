/**
 * The single-statement relational plan: correlated subqueries plus JSON
 * aggregation, the shape Drizzle v1 produces on SQLite.
 *
 * The default plan is the split one in `query.ts` — a query per relation
 * level, stitched in JavaScript. It reads well in a log, keeps `rows_read`
 * proportional to what was asked for, and binds no parent-key list wider than
 * `json_each` can carry. What it costs is round trips: one per level, and on
 * `--remote` every round trip is an HTTPS call to Cloudflare.
 *
 * This module trades that the other way. Everything comes back in one
 * statement:
 *
 * ```sql
 * select "d0"."id" as "id",
 *   coalesce((select json_group_array(json_object('id', "id", 'title', "title"))
 *             from (select "d1"."id" as "id", "d1"."title" as "title"
 *                   from "posts" as "d1"
 *                   where "d0"."id" = "d1"."author_id") as "t"), json_array()) as "posts"
 * from "users" as "d0"
 * ```
 *
 * The trade is real in both directions and neither plan dominates: this one
 * makes one call but runs the inner query once per outer row, while the split
 * plan makes N calls but does N index scans. Which wins depends on row counts
 * and latency, so the strategy is a switch rather than a replacement — see
 * `relationalStrategy` on `drizzle()`.
 *
 * SQLite has no `LATERAL`, which is why this is a correlated subquery rather
 * than the lateral join Drizzle emits on Postgres. The two are equivalent
 * here: an inner query evaluated per outer row.
 */
import type { Column } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import { alias, getTableColumns, getTableName, getTableOriginalName } from '../schema/table.js';
import type { SQLChunk } from '../sql/sql.js';
import { sql } from '../sql/sql.js';
import type { Relation, RelationsConfig, TableRelationalConfig } from './define.js';
import type { FindConfig } from './query.js';

/** How a level's JSON payload maps back onto decoded values. */
export interface JoinedShape {
	/** Column key → its decoder, when it has one. */
	readonly columns: Record<string, ((value: unknown) => unknown) | undefined>;
	readonly relations: Record<string, { readonly many: boolean; readonly shape: JoinedShape }>;
}

/** Quote an identifier for embedding in raw SQL. */
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Quote a SQL string literal — the keys inside `json_object`. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * The column key a `Column` is filed under in a table config.
 *
 * Relations carry column objects; the projection is keyed by TypeScript name,
 * and the two differ whenever a column was declared with an explicit SQL name.
 */
const fieldNameOf = (columns: Record<string, Column<any>>, column: Column<any>): string => {
	for (const [key, candidate] of Object.entries(columns)) {
		if (candidate.name === column.name) return key;
	}
	return column.name;
};

/**
 * Whether every relation this config reaches can be expressed as a correlated
 * subquery.
 *
 * `through` (many-to-many across a junction) is the gap: it needs a join
 * inside the inner select, which this builder does not emit. Rather than
 * produce subtly wrong SQL, the caller falls back to the split plan for the
 * whole query — the two return identical results, so falling back costs
 * latency and nothing else.
 */
export function supportsJoined(
	config: FindConfig,
	tableConfig: TableRelationalConfig,
	schema: RelationsConfig,
): boolean {
	for (const [name, value] of Object.entries(config.with ?? {})) {
		if (!value) continue;
		const relation = tableConfig.relations[name];
		if (!relation) return false;
		// A junction relation needs a join in the inner select.
		if (relation.throughTable) return false;
		if (!relation.sourceColumns || !relation.targetColumns) return false;

		const target = schema[relation.targetTableName];
		if (!target) return false;
		if (value !== true && !supportsJoined(value as FindConfig, target, schema)) return false;
	}
	return true;
}

/** Which columns a level projects: explicit `true`s win, else all but `false`. */
const pickColumns = (
	all: Record<string, Column<any>>,
	selection: Record<string, boolean | undefined> | undefined,
): string[] => {
	const keys = Object.keys(all);
	if (!selection) return keys;
	const included = keys.filter((key) => selection[key] === true);
	if (included.length > 0) return included;
	return keys.filter((key) => selection[key] !== false);
};

export interface JoinedLevel {
	/** Column key → the expression selected for it. */
	readonly selection: Record<string, SQLChunk>;
	readonly shape: JoinedShape;
}

/**
 * Build one level's selection, with each `with` relation as a JSON subquery.
 *
 * `aliasOf` hands out `d0`, `d1`, … so a self-referencing relation — a comment
 * with its parent comment — gets a distinct name per level and the correlation
 * predicate cannot bind to the wrong one.
 */
export function buildLevel(
	table: Table,
	tableConfig: TableRelationalConfig,
	config: FindConfig,
	schema: RelationsConfig,
	next: () => string,
	compileWhere: (config: FindConfig, tableConfig: TableRelationalConfig, table: Table) => SQLChunk | undefined,
	resolveOrderBy: (config: FindConfig, columns: Record<string, Column<any>>) => SQLChunk[],
): JoinedLevel {
	const columns = getTableColumns(table) as unknown as Record<string, Column<any>>;
	const projected = pickColumns(tableConfig.columns, config.columns);

	const selection: Record<string, SQLChunk> = {};
	const shapeColumns: Record<string, ((value: unknown) => unknown) | undefined> = {};
	for (const key of projected) {
		const column = columns[key];
		if (!column) continue;
		selection[key] = column;
		shapeColumns[key] = column.config.decode;
	}

	const relations: JoinedShape['relations'] = {};

	for (const [name, value] of Object.entries(config.with ?? {})) {
		if (!value) continue;
		const relation = tableConfig.relations[name]!;
		const childConfig: FindConfig = value === true ? {} : value as FindConfig;
		const targetConfig = schema[relation.targetTableName]!;

		const childAlias = next();
		const childTable = alias(targetConfig.table, childAlias) as unknown as Table;
		const childColumns = getTableColumns(childTable) as unknown as Record<string, Column<any>>;

		const child = buildLevel(childTable, targetConfig, childConfig, schema, next, compileWhere, resolveOrderBy);

		// Correlate the inner query to this level: parent source column equals
		// child target column, positionally, for composite keys too.
		const predicates: SQLChunk[] = relation.sourceColumns!.map((source, i) => {
			const target = relation.targetColumns![i]!;
			const parent = columns[fieldNameOf(tableConfig.columns, source)]!;
			const childColumn = childColumns[fieldNameOf(targetConfig.columns, target)]!;
			return sql`${parent} = ${childColumn}`;
		});

		const filter = compileWhere(childConfig, targetConfig, childTable);
		if (filter) predicates.push(filter);

		const inner = renderInner(
			childTable,
			child.selection,
			predicates,
			resolveOrderBy(childConfig, childColumns),
			childConfig,
			relation,
		);

		const objectArgs = Object.keys(child.selection)
			.map((key) => `${literal(key)}, ${quote(key)}`)
			.join(', ');

		const many = relation.relationType === 'many';
		selection[name] = many
			// `coalesce(…, json_array())` so a parent with no children gets `[]`
			// rather than SQL NULL, which is what the split plan returns.
			? sql`coalesce((select json_group_array(json_object(${sql.raw(objectArgs)})) from (${inner}) as "t"), json_array())`
			: sql`(select json_object(${sql.raw(objectArgs)}) from (${inner}) as "t")`;

		relations[name] = { many, shape: child.shape };
	}

	return { selection, shape: { columns: shapeColumns, relations } };
}

/** `select … from <child> where <correlation> [order by …] [limit …]`. */
const renderInner = (
	table: Table,
	selection: Record<string, SQLChunk>,
	predicates: readonly SQLChunk[],
	orderBy: readonly SQLChunk[],
	config: FindConfig,
	relation: Relation,
): SQLChunk => {
	const projection = sql.join(
		Object.entries(selection).map(([key, expr]) => sql`${expr} as ${sql.raw(quote(key))}`),
		', ',
	);

	// `from "posts" as "d1zzle_j1"`, spelled out: rendering the aliased table
	// object directly emits only its alias, which SQLite reads as a table of
	// that name — so the inner query looked for a table called "d1zzle_j1".
	const from = sql.raw(`${quote(getTableOriginalName(table))} as ${quote(getTableName(table))}`);
	let out = sql`select ${projection} from ${from} where ${sql.join([...predicates], ' and ')}`;
	if (orderBy.length > 0) out = sql`${out} order by ${sql.join([...orderBy], ', ')}`;

	// A `one` relation takes at most one row whatever the data says, so the
	// limit is not optional: without it a broken key would silently pick an
	// arbitrary row out of several.
	if (relation.relationType === 'one') out = sql`${out} limit 1`;
	else if (config.limit !== undefined) out = sql`${out} limit ${config.limit}`;

	if (config.offset !== undefined) out = sql`${out} offset ${config.offset}`;
	return out;
};

/**
 * Turn one driver row into the shape the split plan returns.
 *
 * The relation payloads arrive as JSON text, so their values never went
 * through a column's decoder — a `timestamp_ms` comes back as a number and a
 * `boolean` as 0/1. Applying the decoders here is what makes the two plans
 * return equal values rather than merely equal shapes.
 */
export function decodeJoined(row: Record<string, unknown>, shape: JoinedShape): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		const relation = shape.relations[key];
		if (!relation) {
			// Top-level columns are decoded by the compiler already.
			out[key] = value;
			continue;
		}

		const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
		if (relation.many) {
			out[key] = Array.isArray(parsed)
				? parsed.map((entry) => decodeNested(entry as Record<string, unknown>, relation.shape))
				: [];
		} else {
			out[key] = parsed === null || parsed === undefined
				? undefined
				: decodeNested(parsed as Record<string, unknown>, relation.shape);
		}
	}

	return out;
}

/** As {@link decodeJoined}, but also decodes this level's own columns. */
const decodeNested = (row: Record<string, unknown>, shape: JoinedShape): Record<string, unknown> => {
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		const relation = shape.relations[key];
		if (relation) {
			const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
			if (relation.many) {
				out[key] = Array.isArray(parsed)
					? parsed.map((entry) => decodeNested(entry as Record<string, unknown>, relation.shape))
					: [];
			} else {
				out[key] = parsed === null || parsed === undefined
					? undefined
					: decodeNested(parsed as Record<string, unknown>, relation.shape);
			}
			continue;
		}

		const decode = shape.columns[key];
		out[key] = decode && value !== null ? decode(value) : value;
	}

	return out;
};
