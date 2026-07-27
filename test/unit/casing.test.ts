/**
 * Casing is module-global and resolved lazily, which is what lets a schema
 * module be imported before the option is known. The cost is that the order of
 * "set the option" and "read a name" matters, and getting it wrong produces
 * SQL that is wrong rather than SQL that fails to build — so both bad orders
 * throw at the point of the mistake.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { configureCasing, resetCasing } from '../../src/schema/columns.js';
import { integer, sqliteTable, text } from '../../src/index.js';

afterEach(() => resetCasing());

describe('configureCasing', () => {
	it('applies to names that were not read before it was set', () => {
		configureCasing('snake_case');
		const t = sqliteTable('t', { firstName: text() });
		expect(t.firstName.name).toBe('first_name');
	});

	it('refuses to change an already-configured mode', () => {
		configureCasing('snake_case');
		expect(() => configureCasing('preserve')).toThrow(/already configured/);
	});

	it('refuses to take effect after a name has already been resolved', () => {
		// This is the documented module-scope compilation: a query built at
		// import time bakes `"firstName"` into its SQL, and a later
		// `d1zzle(env.DB, { casing: 'snake_case' })` would make every *other*
		// reader say `first_name`. The compiled query keeps the old text and D1
		// answers "no such column" — in production, for the optimised query.
		const t = sqliteTable('t', { firstName: text(), id: integer() });
		expect(t.firstName.name).toBe('firstName');

		expect(() => configureCasing('snake_case')).toThrow(/after column names had already been read/);
	});

	it('tolerates a late call that changes nothing', () => {
		const t = sqliteTable('t', { firstName: text() });
		expect(t.firstName.name).toBe('firstName');

		// Redundant, but not a mistake: the names it would produce are the ones
		// already handed out.
		expect(() => configureCasing('preserve')).not.toThrow();
	});
});
