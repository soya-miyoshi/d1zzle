/**
 * The fixture schema used across the suite. Written in the Drizzle dialect
 * (`sqliteTable`, `mode` options, both table-extras forms) so it doubles as
 * the compatibility fixture.
 */
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	real,
	sql,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from '../src/index.js';
import { defineRelations } from '../src/relations/index.js';

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull().unique(),
	name: text('name'),
	role: text('role', { enum: ['admin', 'member'] as const }).notNull().default('member'),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	settings: text('settings', { mode: 'json' }).$type<{ theme: string }>(),
	score: real('score'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date(0)),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$onUpdate(() => new Date(0)),
}, (t) => [
	index('users_name_idx').on(t.name),
	uniqueIndex('users_email_active_idx').on(t.email, t.active).where(sql`${t.active} = 1`),
	check('users_score_check', sql`${t.score} >= 0`),
]);

export const posts = sqliteTable('posts', {
	id: integer('id').primaryKey(),
	authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	views: integer('views').notNull().default(0),
}, (t) => [index('posts_author_idx').on(t.authorId)]);

/** Composite primary key, a table-level FK, and the legacy object-returning form. */
export const postTags = sqliteTable('post_tags', {
	postId: integer('post_id').notNull(),
	tag: text('tag').notNull(),
	addedBy: integer('added_by'),
}, (t) => ({
	pk: primaryKey({ columns: [t.postId, t.tag] }),
	fk: foreignKey({ columns: [t.postId], foreignColumns: [posts.id] }).onDelete('cascade'),
	uq: unique('post_tags_tag_unique').on(t.tag),
}));

/** Every statement needed to build the fixture in a fresh database. */
export const allTables = [users, posts, postTags];

// ---------------------------------------------------------------- relations

/**
 * Declared in v1's shape: the join is stated once, on whichever side is
 * convenient, and the opposite side picks it up. `author` is `optional: false`
 * because `posts.authorId` is `notNull` — which is what takes `| null` off the
 * inferred row.
 */
export const relations = defineRelations({ users, posts, postTags }, (r) => ({
	users: {
		posts: r.many.posts(),
	},
	posts: {
		author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }),
		tags: r.many.postTags(),
	},
	postTags: {
		post: r.one.posts({ from: r.postTags.postId, to: r.posts.id, optional: false }),
	},
}));
