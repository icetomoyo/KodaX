/**
 * History: the saved conversation of a Session, read a page at a time. A page
 * holds the same items a view shows, so a client draws both the same way, and
 * `item.read` returns the whole text of any of them.
 *
 * The ids on a page belong to the conversation as it was when that page was
 * read. Cursors keep reading that conversation. Once the Host no longer keeps
 * it, a cursor or an id fails with `resync_required` and the client starts
 * again from the newest page.
 */
import { z } from 'zod/v4';

import { hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef, TurnRef } from './session.js';
import { ItemId, LocalViewItem, ViewItem } from './view.js';

const Cursor = z.string().min(1).max(1024);

/** What kept the Host from reading part of the conversation. */
const Issue = z.object({
  code: z.string(),
  message: z.string(),
  /** How many entries it affects. */
  entryCount: z.int(),
});

const page = <Item extends z.ZodType>(item: Item) => hostResult({
  /** Oldest first. None of them is `live`: what a Run is still writing is in the view. */
  items: z.array(item),
  /** `resolved` when the whole conversation could be read. Any other value comes with `issues`. */
  status: z.string(),
  issues: z.array(Issue),
  /** Reads the page before this one. Absent on the oldest page. */
  nextCursor: z.string().optional(),
  /** Reads the page after this one. Absent on the newest page. */
  newerCursor: z.string().optional(),
  /** The first item of what `around` named. Absent when the conversation no longer holds it. */
  locatedItemId: z.string().optional(),
});

export const HISTORY_METHODS = {
  /** Without `cursor` and `around`, answers with the newest page. */
  'history.read': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      /** Counts entries of the conversation. One entry can show as several items. */
      limit: z.int().min(1).max(200).optional(),
      cursor: Cursor.optional(),
      /** Answers with the page around what `history.search` found. Not to be sent with `cursor`. */
      around: z.strictObject({ itemId: ItemId }).optional(),
    }),
    result: page(ViewItem),
    localResult: page(LocalViewItem),
  },
  /** Finds text anywhere in what the Session said, including what was summarised away since. */
  'history.search': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      query: z.string().min(1).max(1024),
      limit: z.int().min(1).max(20).optional(),
      role: z.enum(['user', 'assistant']).optional(),
    }),
    result: hostResult({
      /** Best match first. */
      items: z.array(z.object({
        /** Reads with `item.read`, and names the place for `history.read`'s `around`. */
        itemId: z.string(),
        role: z.enum(['user', 'assistant']),
        at: z.int().optional(),
        /** The text around the match. */
        snippet: z.string(),
      })),
    }),
  },
  /**
   * Names one turn of the conversation: a message of the user and what the
   * Session answered. The answer's `ref` is what `session.fork` and
   * `session.rewind` take. Without `turn`, names the newest one.
   */
  'history.resolveTurn': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      turn: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('latest') }),
        /** The turn before the newest. */
        z.strictObject({ kind: z.literal('previous') }),
        /** Counts turns from the oldest, which is 0. */
        z.strictObject({ kind: z.literal('index'), index: z.int().min(0) }),
        /** The turn an item belongs to. The item comes from a view or from a history page. */
        z.strictObject({ kind: z.literal('item'), itemId: ItemId }),
      ]).optional(),
    }),
    result: hostResult({
      turn: z.object({
        ref: TurnRef,
        /** Counts from the oldest turn, which is 0. */
        index: z.int(),
        /** The start of the user's message, to show which turn this is. */
        excerpt: z.string(),
        hasLaterTurn: z.boolean(),
      }).optional(),
      /** Set in place of `turn` when no turn can be named, with the reason, such as `no_turns` or `item_not_found`. */
      unavailable: z.string().optional(),
    }),
  },
} as const satisfies HostMethodRegistry;
