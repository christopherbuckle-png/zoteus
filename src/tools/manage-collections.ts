import { z } from 'zod';
import { collectionRow, newLibraryVersion, writeFailures, writeTarget } from './common-output.js';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, resolveLibrary, requireBulkConfirm, writeResult } from '../registry/registry.js';
import { collectionListing, listingArgs, listingOutput } from './collection-listing.js';
import { mustFallBack, withLibraryWriter, type LibraryWriter } from './library-writer.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** " via the Zotero desktop app" when the desktop took the write, so a summary says where it went. */
function via(w: LibraryWriter): string {
  return w.target === 'local' ? ' via the Zotero desktop app' : '';
}

/** What a write action needs before anything is read or sent, or the refusal saying so. */
function missingArgs(args: any): string | undefined {
  switch (args.action) {
    case 'create':
      return args.name ? undefined : '`name` is required for create.';
    case 'rename':
      if (!args.collection_key) return '`collection_key` is required.';
      return args.name ? undefined : '`name` is required for rename.';
    case 'reparent':
    case 'delete':
      return args.collection_key ? undefined : '`collection_key` is required.';
    default:
      return args.collection_key && args.item_keys?.length ? undefined : '`collection_key` and `item_keys` are required.';
  }
}

/**
 * Every write action, on whichever API `w` writes to. The reads in here (the collection to
 * rename, each item's current collections) come from that same API, because the version a
 * write carries is checked against the copy it lands in.
 */
async function writeCollectionAction(w: LibraryWriter, args: any): Promise<ToolHandlerResult> {
  if (args.action === 'create') {
    const result = await w.writeCollections([{ name: args.name, parentCollection: args.parent_collection ?? false }]);
    if (result.failed.length) return err(`Create failed: ${JSON.stringify(result.failed)}`);
    return ok(
      { created: result.successful.map((s) => s.key), target: w.target, libraryVersion: result.newLibraryVersion },
      `Created collection "${args.name}"${args.parent_collection ? ` inside ${args.parent_collection}` : ''}${via(w)}.`,
    );
  }

  if (args.action === 'rename' || args.action === 'reparent') {
    // The collection by key, asked for directly. This used to scan one page of 100 for it,
    // so in a library with more collections than that, most keys were "not found" (#90).
    const existing = await w.getCollection(args.collection_key);
    if (!existing) return err(`Collection ${args.collection_key} not found.`);
    const obj: any = {
      ...existing.data,
      key: args.collection_key,
      version: existing.version ?? existing.data?.version,
    };
    if (args.action === 'rename') obj.name = args.name;
    else obj.parentCollection = args.parent_collection ?? false;
    const result = await w.writeCollections([obj]);
    if (result.failed.length) return err(`Update failed: ${JSON.stringify(result.failed)}`);
    return ok(
      { collection_key: args.collection_key, target: w.target, libraryVersion: result.newLibraryVersion },
      `${args.action === 'rename' ? 'Renamed' : 'Reparented'} collection ${args.collection_key}${via(w)}.`,
    );
  }

  if (args.action === 'delete') {
    await w.deleteCollections([args.collection_key]);
    return ok({ deleted: args.collection_key, target: w.target }, `Deleted collection ${args.collection_key}${via(w)}.`);
  }

  // add_items / remove_items: collection membership lives on each item.
  const updated: string[] = [];
  const failed: Array<{ key: string; message: string }> = [];
  for (const key of args.item_keys as string[]) {
    try {
      const item = await w.getItem(key);
      const version = item?.version ?? item?.data?.version;
      const cols: string[] = Array.isArray(item?.data?.collections) ? [...item.data.collections] : [];
      const next =
        args.action === 'add_items'
          ? cols.includes(args.collection_key)
            ? cols
            : [...cols, args.collection_key]
          : cols.filter((c) => c !== args.collection_key);
      await w.patchItem(key, { collections: next }, version);
      updated.push(key);
    } catch (e) {
      if (mustFallBack(e)) throw e;
      failed.push({ key, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return writeResult(
    { updated, failed, target: w.target },
    `${args.action === 'add_items' ? 'Added' : 'Removed'} ${updated.length} item(s) ${
      args.action === 'add_items' ? 'to' : 'from'
    } ${args.collection_key}${via(w)}.`,
    updated.length,
    args.item_keys.length,
    failed,
  );
}

const manageCollections: ToolDefinition = {
  name: 'zotero_manage_collections',
  title: 'Manage Zotero collections',
  description:
    'List, create, rename, reparent, or delete collections, and move items into or out of a collection. Set `action` to one of: "list" (collections with key/name/parent, sorted by name; `q` filters by name over the whole library, `start`/`limit` page, `totalResults` counts them all), "create" (needs `name`, optional `parent_collection` key; omit it for top-level), "rename" (needs `collection_key` + `name`), "reparent" (needs `collection_key`; `parent_collection` key, or omit to move to top level), "delete" (needs `collection_key`), "add_items" / "remove_items" (need `collection_key` + `item_keys`; collection membership lives on each item). Writes to your personal library go to the running Zotero desktop app (Zotero 10+) and otherwise to the cloud Web API; group libraries always write to the cloud. When the server sets a bulk-write threshold (ZOTEUS_CONFIRM_BULK_WRITES, off by default), removing more items than that from a collection in one call also needs `confirm: true`.',
  inputSchema: {
    action: z
      .enum(['list', 'create', 'rename', 'reparent', 'delete', 'add_items', 'remove_items'])
      .describe(
        'What to do. "list" reads every collection (then `q`, `start`, `limit` apply); "create" needs `name`; "rename" needs `collection_key` + `name`; "reparent" needs `collection_key`; "delete" needs `collection_key`; "add_items"/"remove_items" need `collection_key` + `item_keys`.',
      ),
    name: z.string().optional().describe('Collection name (create/rename).'),
    collection_key: z.string().optional().describe('Target collection key (all actions except list/create).'),
    parent_collection: z.string().optional().describe('Parent collection key; omit for top-level.'),
    item_keys: z.array(z.string()).optional().describe('Item keys (add_items/remove_items).'),
    confirm: z
      .boolean()
      .optional()
      .describe("Required to remove more items in one call than the server's bulk-write threshold."),
    ...listingArgs,
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      collections: z.array(collectionRow).optional().describe('This page of the collections, sorted by name (action:"list").'),
      ...listingOutput,
      created: z.array(z.string()).optional().describe('Key of the collection created (action:"create").'),
      collection_key: z.string().optional().describe('The collection renamed or reparented.'),
      deleted: z.string().optional().describe('Key of the collection deleted.'),
      updated: z.array(z.string()).optional().describe('Item keys added to or removed from the collection.'),
      failed: writeFailures,
      target: writeTarget,
      libraryVersion: newLibraryVersion,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      // Routed like every other read, but in the library the caller named: listing the
      // personal library's collections for a call that named a group handed the model
      // collection keys that do not exist there, and the create that followed failed or
      // landed in the wrong place (#74). Every page of it, not the first (#90).
      return collectionListing(ctx, args);
    }

    const missing = missingArgs(args);
    if (missing) return err(missing);
    // add_items only widens membership; remove_items is the lossy direction.
    if (args.action === 'remove_items') {
      const refusal = requireBulkConfirm(ctx, args.item_keys!.length, 'remove from a collection', args.confirm);
      if (refusal) return refusal;
    }
    // The running desktop app for the personal library, the cloud otherwise. Every action
    // here was cloud-only until now, so a Zotero 10 desktop with no key could read its
    // collections and not make one (Zotero 10's local API takes all of these writes).
    return withLibraryWriter(ctx, resolveLibrary(ctx, args), (w) => writeCollectionAction(w, args));
  },
};

export default manageCollections;
