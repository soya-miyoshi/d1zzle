/**
 * Row mappers.
 *
 * Rule R2 forbids `new Function`, so a mapper is a monomorphic loop over
 * precomputed arrays rather than generated source. Every output object is
 * built with the same keys in the same order, so V8 gives them one hidden
 * class — that shape stability is most of the win.
 */

export interface FieldPlan {
	/** Output path: `['id']`, or `['user', 'id']` for a nested selection. */
	readonly path: readonly string[];
	/** Position in the result row. */
	readonly index: number;
	/** Key in the keyed (batch) read path. */
	readonly key: string;
	readonly decode: ((value: unknown) => unknown) | undefined;
}

/** A nested object in the output shape. */
interface GroupSpec {
	readonly key: string;
	readonly children: readonly Node[];
	/**
	 * True when the group comes from an outer-joined table: if every one of its
	 * fields is null, the whole group is null rather than an object of nulls.
	 */
	readonly nullable: boolean;
	readonly indexes: readonly number[];
}

interface LeafSpec {
	readonly key: string;
	readonly index: number;
	readonly decode: ((value: unknown) => unknown) | undefined;
}

type Node = { readonly kind: 'leaf'; readonly leaf: LeafSpec } | { readonly kind: 'group'; readonly group: GroupSpec };

export interface Shape {
	readonly nodes: readonly Node[];
	readonly flat: boolean;
}

/** Build the output shape from a flat field list plus the set of nullable groups. */
export function buildShape(fields: readonly FieldPlan[], nullableGroups: ReadonlySet<string>): Shape {
	const flat = fields.every((f) => f.path.length === 1);
	if (flat) {
		return {
			flat: true,
			nodes: fields.map((f) => ({
				kind: 'leaf' as const,
				leaf: { key: f.path[0]!, index: f.index, decode: f.decode },
			})),
		};
	}

	interface Draft {
		key: string;
		children: Draft[];
		leaf?: LeafSpec;
		indexes: number[];
		path: string;
	}

	const root: Draft = { key: '', children: [], indexes: [], path: '' };
	const find = (parent: Draft, key: string, path: string): Draft => {
		let node = parent.children.find((c) => c.key === key && !c.leaf);
		if (!node) {
			node = { key, children: [], indexes: [], path };
			parent.children.push(node);
		}
		return node;
	};

	for (const field of fields) {
		let parent = root;
		for (let i = 0; i < field.path.length - 1; i++) {
			const segment = field.path[i]!;
			parent = find(parent, segment, parent.path ? `${parent.path}.${segment}` : segment);
			parent.indexes.push(field.index);
		}
		parent.children.push({
			key: field.path.at(-1)!,
			children: [],
			indexes: [],
			path: '',
			leaf: { key: field.path.at(-1)!, index: field.index, decode: field.decode },
		});
	}

	const toNode = (draft: Draft): Node =>
		draft.leaf
			? { kind: 'leaf', leaf: draft.leaf }
			: {
				kind: 'group',
				group: {
					key: draft.key,
					children: draft.children.map(toNode),
					nullable: nullableGroups.has(draft.path),
					indexes: draft.indexes,
				},
			};

	return { flat: false, nodes: root.children.map(toNode) };
}

const readRow = (nodes: readonly Node[], read: (index: number) => unknown): Record<string, unknown> => {
	const obj: Record<string, unknown> = {};
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		if (node.kind === 'leaf') {
			const raw = read(node.leaf.index);
			obj[node.leaf.key] = raw === null || raw === undefined
				? null
				: node.leaf.decode
				? node.leaf.decode(raw)
				: raw;
			continue;
		}
		const group = node.group;
		if (group.nullable && group.indexes.every((index) => read(index) === null || read(index) === undefined)) {
			obj[group.key] = null;
			continue;
		}
		obj[group.key] = readRow(group.children, read);
	}
	return obj;
};

/** Positional mapper — the direct `.raw()` read path. */
export function buildPositionalMapper<T>(shape: Shape): (rows: unknown[][]) => T[] {
	if (shape.flat) {
		const leaves = shape.nodes.map((n) => (n as { leaf: LeafSpec }).leaf);
		return (rows) => {
			const out: T[] = new Array(rows.length);
			for (let r = 0; r < rows.length; r++) {
				const row = rows[r]!;
				const obj: Record<string, unknown> = {};
				for (let f = 0; f < leaves.length; f++) {
					const leaf = leaves[f]!;
					const raw = row[leaf.index];
					obj[leaf.key] = raw === null || raw === undefined ? null : leaf.decode ? leaf.decode(raw) : raw;
				}
				out[r] = obj as T;
			}
			return out;
		};
	}

	return (rows) => rows.map((row) => readRow(shape.nodes, (index) => row[index]) as T);
}

/** Keyed mapper — used inside `batch()`, where `.raw()` is unavailable. */
export function buildKeyedMapper<T>(
	shape: Shape,
	fields: readonly FieldPlan[],
): (rows: Record<string, unknown>[]) => T[] {
	const keyByIndex: string[] = [];
	for (const field of fields) keyByIndex[field.index] = field.key;

	return (rows) =>
		rows.map((row) => readRow(shape.nodes, (index) => row[keyByIndex[index]!]) as T);
}
