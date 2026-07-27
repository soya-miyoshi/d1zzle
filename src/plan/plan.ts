import type { Column } from '../schema/columns.js';
import type { Table } from '../schema/table.js';
import type { Placeholder, SQLChunk } from '../sql/sql.js';

/** A projection: columns, expressions, or one level of nesting per entry. */
export type SelectionEntry = Column<any> | SQLChunk | Selection;
export interface Selection {
	readonly [key: string]: SelectionEntry;
}

export type JoinType = 'inner' | 'left' | 'right' | 'full' | 'cross';

export interface Join {
	readonly type: JoinType;
	readonly table: Table;
	readonly on: SQLChunk | undefined;
}

export type Limit = number | Placeholder | undefined;

export interface SelectPlan {
	readonly kind: 'select';
	readonly from: Table | undefined;
	/** `undefined` means "all columns of `from` (and of every join)". */
	readonly selection: Selection | undefined;
	readonly joins: readonly Join[];
	readonly where: SQLChunk | undefined;
	readonly groupBy: readonly SQLChunk[];
	readonly having: SQLChunk | undefined;
	readonly orderBy: readonly SQLChunk[];
	readonly limit: Limit;
	readonly offset: Limit;
	readonly distinct: boolean;
}

export interface ConflictTarget {
	readonly columns: readonly Column<any>[];
	readonly where: SQLChunk | undefined;
}

export interface OnConflict {
	readonly target: ConflictTarget | undefined;
	readonly doNothing: boolean;
	readonly set: Record<string, unknown> | undefined;
	readonly setWhere: SQLChunk | undefined;
}

export interface InsertPlan {
	readonly kind: 'insert';
	readonly table: Table;
	readonly values: readonly Record<string, unknown>[];
	readonly onConflict: OnConflict | undefined;
	readonly returning: Selection | true | undefined;
}

export interface UpdatePlan {
	readonly kind: 'update';
	readonly table: Table;
	readonly set: Record<string, unknown>;
	readonly where: SQLChunk | undefined;
	readonly returning: Selection | true | undefined;
}

export interface DeletePlan {
	readonly kind: 'delete';
	readonly table: Table;
	readonly where: SQLChunk | undefined;
	readonly returning: Selection | true | undefined;
}

export type Plan = SelectPlan | InsertPlan | UpdatePlan | DeletePlan;

export const emptySelectPlan = (from: Table | undefined, selection: Selection | undefined): SelectPlan => ({
	kind: 'select',
	from,
	selection,
	joins: [],
	where: undefined,
	groupBy: [],
	having: undefined,
	orderBy: [],
	limit: undefined,
	offset: undefined,
	distinct: false,
});
