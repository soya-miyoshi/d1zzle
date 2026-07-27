/**
 * The migrations folder, in wrangler's layout:
 *
 * ```
 * migrations/
 *   0000_lively_moon.sql
 *   meta/_journal.json
 *   meta/0000_snapshot.json
 * ```
 *
 * Wrangler reads the `.sql` files; the kit reads `meta/`. Both appliers agree
 * because they share the same table and the same file names.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importModule } from './import.js';
import type { Journal } from '../core/journal.js';
import { emptyJournal } from '../core/journal.js';
import type { Snapshot } from '../core/snapshot.js';
import { emptySnapshot } from '../core/snapshot.js';

export const metaDir = (out: string): string => join(out, 'meta');
export const journalPath = (out: string): string => join(metaDir(out), '_journal.json');
export const snapshotPath = (out: string, index: number): string =>
	join(metaDir(out), `${String(index).padStart(4, '0')}_snapshot.json`);

export async function readJournal(out: string): Promise<Journal> {
	const path = journalPath(out);
	if (!existsSync(path)) return emptyJournal();
	return JSON.parse(await readFile(path, 'utf8')) as Journal;
}

export async function writeJournal(out: string, journal: Journal): Promise<void> {
	await mkdir(metaDir(out), { recursive: true });
	await writeFile(journalPath(out), `${JSON.stringify(journal, null, '\t')}\n`);
}

/** The snapshot the last migration left behind — the diff's starting point. */
export async function readLatestSnapshot(out: string): Promise<Snapshot> {
	if (!existsSync(metaDir(out))) return emptySnapshot();
	const files = (await readdir(metaDir(out)))
		.filter((f) => f.endsWith('_snapshot.json'))
		.sort();
	const last = files.at(-1);
	if (!last) return emptySnapshot();
	return JSON.parse(await readFile(join(metaDir(out), last), 'utf8')) as Snapshot;
}

/** One specific snapshot, by journal index. `undefined` when it is missing. */
export async function readSnapshot(out: string, index: number): Promise<Snapshot | undefined> {
	const path = snapshotPath(out, index);
	if (!existsSync(path)) return undefined;
	return JSON.parse(await readFile(path, 'utf8')) as Snapshot;
}

export async function writeSnapshot(out: string, index: number, snapshot: Snapshot): Promise<void> {
	await mkdir(metaDir(out), { recursive: true });
	await writeFile(snapshotPath(out, index), `${JSON.stringify(snapshot, null, '\t')}\n`);
}

export async function writeMigration(out: string, tag: string, sql: string): Promise<string> {
	await mkdir(out, { recursive: true });
	const path = join(out, `${tag}.sql`);
	await writeFile(path, `${sql}\n`);
	return path;
}

export async function readMigration(out: string, tag: string): Promise<string> {
	return readFile(join(out, `${tag}.sql`), 'utf8');
}

/** Load a schema module (or several) and return their exports. */
export async function loadSchema(cwd: string, schema: string | string[]): Promise<Record<string, unknown>> {
	const paths = Array.isArray(schema) ? schema : [schema];
	const exports: Record<string, unknown> = {};

	for (const path of paths) {
		const resolved = resolve(cwd, path);
		if (!existsSync(resolved)) throw new Error(`Schema file not found: ${resolved}`);

		// Node caches ES modules by URL. Each CLI run is a fresh process, so this
		// only matters for programmatic callers, who should pass distinct paths.
		Object.assign(exports, await importModule(resolved));
	}

	return exports;
}
