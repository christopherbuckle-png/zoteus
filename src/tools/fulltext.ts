import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, optionalLibrary, resolveLibrary } from '../registry/registry.js';
import { writeTarget } from './common-output.js';
import { withLibraryWriter } from './library-writer.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const fulltext: ToolDefinition = {
  name: 'zotero_fulltext',
  title: 'Attachment full-text',
  description:
    "Not a search: to find which items contain a term, use `zotero_search_items` with qmode=everything. This reads, sets, or tracks one attachment's already-extracted full text by key. `action`: \"get\" returns the indexed text content plus indexing stats for an attachment item (only attachment items have full text; returns found:false if none); \"set\" stores extracted text for an attachment (provide `content` and the indexing counts); \"since\" returns the map of attachment keys whose full text changed after a given library `version` (useful for incremental indexing). Only attachment items support full text. All three go through the running Zotero desktop app when there is one (no cloud key needed; \"set\" needs Zotero 10+ and writes your personal library or a group library the app holds), otherwise the cloud Web API.",
  inputSchema: {
    action: z
      .enum(['get', 'set', 'since'])
      .describe(
        'What to do. "get" reads one attachment\'s indexed text (needs `item_key`); "set" stores extracted text for it (needs `item_key` + `content`); "since" lists attachment keys whose text changed after `since`.',
      ),
    item_key: z.string().optional().describe('Attachment item key (get/set).'),
    since: z.number().int().optional().describe('Library version for "since" (default 0).'),
    content: z.string().optional().describe('Extracted text (set).'),
    indexed_chars: z.number().int().optional().describe('Characters of the document that were indexed (set); defaults to none reported.'),
    total_chars: z.number().int().optional().describe('Characters the document holds in total (set).'),
    indexed_pages: z.number().int().optional().describe('Pages that were indexed (set); PDFs only.'),
    total_pages: z.number().int().optional().describe('Pages the document holds in total (set); PDFs only.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      found: z.boolean().optional().describe('action:"get": whether Zotero holds extracted text for this attachment.'),
      item_key: z.string().optional().describe('The attachment this call addressed.'),
      content: z.string().optional().describe('The extracted text itself (action:"get").'),
      indexedChars: z.number().optional().describe('Characters Zotero has indexed of the document.'),
      totalChars: z.number().optional().describe('Characters the document holds in total.'),
      indexedPages: z.number().optional().describe('Pages indexed (PDFs).'),
      totalPages: z.number().optional().describe('Pages in the document (PDFs).'),
      changed: z
        .record(z.number())
        .optional()
        .describe('action:"since": attachment key to the full-text version it changed at.'),
      count: z.number().optional().describe('How many attachments that map holds.'),
      length: z.number().optional().describe('Characters stored (action:"set").'),
      target: writeTarget,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const readLib = optionalLibrary(args, ctx) ?? ctx.router.defaultLibrary();
    if (args.action === 'get') {
      if (!args.item_key) return err('`item_key` is required for get.');
      const ft = await ctx.router.getFullText(args.item_key, { library: readLib });
      if (!ft) return ok({ found: false, item_key: args.item_key }, `No extracted full text for ${args.item_key}.`);
      const length = typeof ft.content === 'string' ? ft.content.length : 0;
      // `item_key` on both branches: the not-found mirror carried it and the found one did
      // not, so the payload a caller chains on changed shape with the answer.
      return ok({ found: true, item_key: args.item_key, ...ft }, `Full text for ${args.item_key}: ${length} characters.`);
    }

    if (args.action === 'since') {
      const map = await ctx.router.fullTextSince(args.since ?? 0, { library: readLib });
      return ok({ changed: map, count: Object.keys(map).length }, `${Object.keys(map).length} attachment(s) with full-text changes since v${args.since ?? 0}.`);
    }

    // set
    if (!args.item_key || args.content == null) return err('`item_key` and `content` are required for set.');
    // The desktop app for the personal library, the cloud otherwise. This was cloud-only on
    // the grounds that neither desktop write path had a full-text endpoint, which stopped
    // being true when Zotero 10's local API gained `PUT …/items/<key>/fulltext`. A desktop
    // without it answers 501 and the write goes to the cloud as before.
    const body = {
      content: args.content,
      indexedChars: args.indexed_chars,
      totalChars: args.total_chars,
      indexedPages: args.indexed_pages,
      totalPages: args.total_pages,
    };
    return withLibraryWriter(ctx, resolveLibrary(ctx, args), async (w) => {
      await w.setFullText(args.item_key!, body);
      return ok(
        { item_key: args.item_key, length: args.content!.length, target: w.target },
        `Set full text for ${args.item_key}${w.target === 'local' ? ' via the Zotero desktop app' : ''}.`,
      );
    });
  },
};

export default fulltext;
