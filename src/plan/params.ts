import type { D1Param, ParamSlot } from '../sql/sql.js';

export class MissingPlaceholderError extends Error {
	constructor(readonly placeholder: string) {
		super(`No value supplied for placeholder "${placeholder}".`);
		this.name = 'MissingPlaceholderError';
	}
}

/**
 * Fill a compiled parameter plan with concrete values.
 *
 * `const` slots were captured when the query was built; `ph` slots come from
 * the caller; `fn` slots (`$defaultFn` / `$onUpdate`) are evaluated fresh on
 * every execution, which is what keeps a hoisted compiled query correct.
 */
export function bindParams(
	slots: readonly ParamSlot[],
	input: Record<string, unknown> = {},
): D1Param[] {
	const out: D1Param[] = new Array(slots.length);

	for (let i = 0; i < slots.length; i++) {
		const slot = slots[i]!;
		if (slot.k === 'const') {
			out[i] = slot.v;
			continue;
		}
		if (slot.k === 'fn') {
			const value = slot.fn();
			out[i] = value === null || value === undefined
				? null
				: slot.encode
				? slot.encode(value)
				: (value as D1Param);
			continue;
		}
		// `hasOwn`, not `in`: `'constructor' in {}` is true, so a placeholder
		// named after a prototype member would bind a function instead of
		// reporting that nothing was supplied for it.
		if (!Object.hasOwn(input, slot.name)) throw new MissingPlaceholderError(slot.name);
		const value = input[slot.name];
		out[i] = value === null || value === undefined
			? null
			: slot.encode
			? slot.encode(value)
			: (value as D1Param);
	}

	return out;
}
