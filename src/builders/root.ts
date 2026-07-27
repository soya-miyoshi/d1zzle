import type { Selection } from '../plan/plan.js';
import type { Table } from '../schema/table.js';
import { deleteFrom } from './delete.js';
import { InsertRoot } from './insert.js';
import { SelectRoot } from './select.js';
import { UpdateRoot } from './update.js';

/**
 * The db-less query root.
 *
 * Worker bindings live on `env`, which is only available per request, so `db`
 * usually cannot be hoisted. Separating "what the query is" from "which
 * database runs it" is what makes module-scope compilation possible:
 *
 * ```ts
 * const byEmail = query.select().from(users).where(eq(users.email, ph('email'))).compile();
 * // …later, per request:
 * const user = await db.get(byEmail, { email: 'a@b.c' });
 * ```
 */
export const query = {
	select(selection?: Selection): any {
		return new SelectRoot(selection, undefined, false);
	},
	selectDistinct(selection?: Selection): any {
		return new SelectRoot(selection, undefined, true);
	},
	insert<T extends Table>(t: T): InsertRoot<T> {
		return new InsertRoot(t, undefined);
	},
	update<T extends Table>(t: T): UpdateRoot<T> {
		return new UpdateRoot(t, undefined);
	},
	delete<T extends Table>(t: T) {
		return deleteFrom(t, undefined);
	},
} as {
	select(): SelectRoot<undefined>;
	select<TSelection extends Selection>(selection: TSelection): SelectRoot<TSelection>;
	selectDistinct(): SelectRoot<undefined>;
	selectDistinct<TSelection extends Selection>(selection: TSelection): SelectRoot<TSelection>;
	insert<T extends Table>(t: T): InsertRoot<T>;
	update<T extends Table>(t: T): UpdateRoot<T>;
	delete<T extends Table>(t: T): ReturnType<typeof deleteFrom<T>>;
};
