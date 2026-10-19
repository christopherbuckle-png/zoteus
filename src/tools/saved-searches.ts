import { z } from 'zod';
import { newLibraryVersion, writeTarget } from './common-output.js';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, resolveLibrary } from '../registry/registry.js';
import { withLibraryWriter } from './library-writer.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const savedSearches: ToolDefinition = {
  name: 'zotero_saved_searches',
  title: 'Manage Zotero saved searches',
  description:
    'List, create, or delete saved-search DEFINITIONS. NOTE: the Zotero cloud Web API stores saved searches but does NOT execute them — to get the items a saved search matches, run an equivalent zotero_search_items query (or use the desktop local API when available). Set `action` to "list" (all saved searches with their conditions), "create" (needs `name` and `conditions`, each `{condition, operator, value}`), or "delete" (needs `search_key`). Writes to your personal library go to the running Zotero desktop app (Zotero 10+) and otherwise to the cloud Web API; group libraries always write to the cloud.',
  inputSchema: {
    action: z
      .enum(['list', 'create', 'delete'])
      .describe(
        'What to do. "list" returns every saved-search definition; "create" needs `name` + `conditions`; "delete" needs `search_key`.',
      ),
    name: z.string().optional().describe('Saved-search name (create).'),
    conditions: z
      .array(
        z.object({
          condition: z.string().describe('Zotero search field, e.g. "title", "tag", "itemType", "dateAdded".'),
          operator: z.string().describe('Zotero operator for that field, e.g. "is", "isNot", "contains", "doesNotContain", "isBefore".'),
          value: z.string().describe('Value to compare against, as a string, e.g. "kalman" or "journalArticle".'),
        }),
      )
      .optional()
      .describe('Search conditions (create).'),
    search_key: z.string().optional().describe('Saved-search key (delete).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      searches: z
        .array(
          z
            .object({
              key: z.string().optional().describe('8-character saved-search key.'),
              name: z.string().optional().describe('Saved-search name.'),
              conditions: z
                .array(z.record(z.unknown()))
                .optional()
                .describe('Its conditions, each { condition, operator, value } as Zotero stores them.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('Saved-search definitions (action:"list"). The cloud API stores them but does not execute them.'),
      created: z.array(z.string()).optional().describe('Key of the saved search created.'),
      deleted: z.string().optional().describe('Key of the saved search deleted.'),
      target: writeTarget,
      libraryVersion: newLibraryVersion,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      // The caller's library_type/library_id, like every other action here (#74).
      const lib = resolveLibrary(ctx, args);
      const r = await ctx.router.listSearches({ library: lib });
      const searches = r.data.map((s: any) => ({
        key: s.key ?? s.data?.key,
        name: s.data?.name,
        conditions: s.data?.conditions ?? [],
      }));
      return ok({ searches }, `${searches.length} saved search(es). Note: the cloud API does not execute them.`);
    }

    if (args.action === 'create' && (!args.name || !args.conditions?.length)) {
      return err('`name` and at least one `conditions` entry are required for create.');
    }
    if (args.action === 'delete' && !args.search_key) return err('`search_key` is required for delete.');

    // The desktop app for the personal library (Zotero 10's local API stores saved searches
    // too), the cloud otherwise.
    return withLibraryWriter(ctx, resolveLibrary(ctx, args), async (w) => {
      const via = w.target === 'local' ? ' via the Zotero desktop app' : '';
      if (args.action === 'create') {
        const result = await w.writeSearches([{ name: args.name, conditions: args.conditions }]);
        if (result.failed.length) return err(`Create failed: ${JSON.stringify(result.failed)}`);
        return ok(
          { created: result.successful.map((s) => s.key), target: w.target, libraryVersion: result.newLibraryVersion },
          `Created saved search "${args.name}"${via}.`,
        );
      }
      await w.deleteSearches([args.search_key!]);
      return ok({ deleted: args.search_key, target: w.target }, `Deleted saved search ${args.search_key}${via}.`);
    });
  },
};

export default savedSearches;
