/**
 * Importing a project's TypeScript modules from the CLI.
 *
 * Node runs TypeScript directly, so no bundler is needed — the schema is a
 * value, not something to parse. One wrinkle: a `.ts` file in a project
 * without `"type": "module"` is loaded as CommonJS, and its `import`
 * statements fail. Copying it to a sibling `.mts` forces the ESM loader while
 * keeping bare and relative specifiers resolving from the project — which is
 * why the copy has to sit next to the original.
 */
import { copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isModuleSyntaxError = (error: unknown): boolean =>
	error instanceof Error
	&& /import statement outside a module|Unexpected token 'export'|require\(\) of ES Module/.test(error.message);

let shimCounter = 0;

export async function importModule<T = Record<string, unknown>>(path: string): Promise<T> {
	try {
		return await import(pathToFileURL(path).href) as T;
	} catch (error) {
		if (!isModuleSyntaxError(error) || !/\.[cm]?ts$/.test(path)) throw error;

		const shim = join(dirname(path), `.d1zzle-${process.pid}-${shimCounter++}.mts`);
		await copyFile(path, shim);
		try {
			return await import(pathToFileURL(shim).href) as T;
		} finally {
			await rm(shim, { force: true });
		}
	}
}
