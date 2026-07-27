import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** `d1zzle-kit` depends on `d1zzle` as a peer; in-repo it resolves to source. */
const alias = {
	'd1zzle/relations': fileURLToPath(new URL('./src/relations/index.ts', import.meta.url)),
	'd1zzle/ddl': fileURLToPath(new URL('./src/ddl.ts', import.meta.url)),
	'd1zzle': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
};

// Two projects:
//
// - `unit` runs in Node. Everything above `runtime/` is pure and synchronous,
//   so the bulk of the suite — compilation, DDL, the kit's diff engine — needs
//   no workerd and runs in milliseconds.
// - `workers` runs inside workerd (the real Workers runtime) with a local D1
//   binding, so we never assert against a Node-shaped SQLite.
export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					name: 'unit',
					include: ['test/unit/**/*.test.ts', 'kit/test/unit/**/*.test.ts'],
					environment: 'node',
				},
			},
			defineWorkersProject({
				resolve: { alias },
				test: {
					name: 'workers',
					include: ['test/workers/**/*.test.ts', 'kit/test/workers/**/*.test.ts'],
					poolOptions: {
						workers: {
							miniflare: {
								compatibilityDate: '2026-07-01',
								d1Databases: ['DB'],
							},
						},
					},
				},
			}),
		],
	},
});
