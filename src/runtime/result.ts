import type { CompiledQuery } from '../plan/compile.js';
import type { D1Param } from '../sql/sql.js';

/**
 * What `onQuery` receives. `rows_read` / `rows_written` are D1's billing
 * units — the most actionable signal the platform gives you, and the thing
 * most ORMs throw away.
 */
export interface QueryEvent {
	readonly sql: string;
	/** `raw` is `db.execute()`, which has no plan to classify. */
	readonly kind: 'select' | 'insert' | 'update' | 'delete' | 'raw';
	readonly tables: readonly string[];
	/** Wall clock, includes network. */
	readonly durationMs: number;
	/** Excludes network. `durationMs - sqlDurationMs` is the network share. */
	readonly sqlDurationMs?: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	readonly servedByPrimary?: boolean;
	readonly servedByRegion?: string;
	/** > 1 means D1 auto-retried. */
	readonly attempts?: number;
	/** `__DEV__` only — parameters routinely contain PII. */
	readonly params?: readonly D1Param[];
}

type Meta = Partial<D1Meta> & Record<string, unknown>;

export const buildEvent = (
	query: CompiledQuery<unknown>,
	sql: string,
	meta: Meta | undefined,
	durationMs: number,
	params: readonly D1Param[] | undefined,
): QueryEvent => {
	const timings = meta?.['timings'] as { sql_duration_ms?: number } | undefined;
	return {
		sql,
		kind: query.kind,
		tables: query.tables,
		durationMs: meta?.duration ?? durationMs,
		...(timings?.sql_duration_ms !== undefined ? { sqlDurationMs: timings.sql_duration_ms } : {}),
		rowsRead: meta?.rows_read ?? 0,
		rowsWritten: meta?.rows_written ?? 0,
		...(meta?.served_by_primary !== undefined ? { servedByPrimary: meta.served_by_primary } : {}),
		...(meta?.served_by_region !== undefined ? { servedByRegion: meta.served_by_region } : {}),
		...(meta?.['total_attempts'] !== undefined ? { attempts: meta['total_attempts'] as number } : {}),
		...(params ? { params } : {}),
	};
};
