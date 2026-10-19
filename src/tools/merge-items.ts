import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import {
  LIBRARY_CONTENT_PROVENANCE,
  desktopTakesWrites,
  okLibraryContent,
  requireBulkConfirm,
  requireCloud,
  resolveLibrary,
  writeResult,
} from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { provenance, writeFailures, writeTarget } from './common-output.js';
import { ZoteroApiError } from '../api/errors.js';
import type { LibraryRef, ListResult } from '../api/web-client.js';
import { mustFallBack, previewWriter, withLibraryWriter, type LibraryWriter } from './library-writer.js';
import {
  buildMergePlan,
  type ChildRecord,
  type ItemRecord,
  type MergePlan,
} from '../features/dedupe/merge-plan.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function statusOf(e: unknown): number | undefined {
  return e instanceof ZoteroApiError ? e.status : undefined;
}

/** An item as either API hands it over, reduced to the three things a merge needs. */
function toRecord(item: any): ItemRecord | undefined {
  const data = (item?.data ?? item) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return undefined;
  const key = String(data.key ?? item?.key ?? '');
  if (!key) return undefined;
  return { key, version: versionOf(item), data };
}

function toChild(item: any, from: string): ChildRecord | undefined {
  const rec = toRecord(item);
  if (!rec) return undefined;
  return {
    key: rec.key,
    version: rec.version,
    itemType: typeof rec.data.itemType === 'string' ? rec.data.itemType : undefined,
    title:
      typeof rec.data.title === 'string'
        ? rec.data.title
        : typeof rec.data.filename === 'string'
          ? rec.data.filename
          : undefined,
    from,
  };
}

/** Notes and attachments carry content that bibliographic field merging cannot preserve. */
function isMergeableRecord(item: ItemRecord): boolean {
  return !item.data.deleted && !item.data.parentItem &&
    !['attachment', 'note', 'annotation'].includes(String(item.data.itemType ?? ''));
}

/**
 * The Zotero URI of an item, which is what the `relations` field holds.
 *
 * `users/0` is how the desktop app addresses the personal library when no cloud key is
 * configured, and it is not a URI any other Zotero would recognise, so the real user id is
 * preferred whenever one is known: the cloud key's, or else the one the desktop app reports
 * on its own records (`library.id`, the account it syncs as).
 */
function itemUriFor(ctx: ToolContext, lib: LibraryRef, desktopUserId?: number): (key: string) => string {
  const id = lib.type === 'user' && !lib.id ? (ctx.capabilities.cloud?.userID ?? desktopUserId ?? 0) : lib.id;
  const base = `http://zotero.org/${lib.type === 'group' ? 'groups' : 'users'}/${id}/items/`;
  return (key: string) => base + key;
}

/** The account id the desktop app reports on a personal-library record, if it syncs as one. */
function recordUserId(item: any): number | undefined {
  const lib = item?.library;
  return lib?.type === 'user' && Number.isSafeInteger(lib.id) && lib.id > 0 ? lib.id : undefined;
}

/** Reading the records a plan is computed from, from one backend and one only. */
interface Reader {
  getItem(key: string): Promise<any>;
  getChildren(key: string): Promise<any[]>;
}

/** Read all children before promising to trash their parent. */
async function allChildren(readPage: (start: number, limit: number) => Promise<ListResult>): Promise<any[]> {
  const children: any[] = [];
  const seen = new Set<string>();
  const limit = 100;
  let version: number | undefined;
  for (;;) {
    const page = await readPage(children.length, limit);
    if (version !== undefined && page.lastModifiedVersion !== version) {
      throw new Error('The library changed while child items were being listed; retry the merge.');
    }
    version = page.lastModifiedVersion;
    for (const raw of page.data) {
      const key = toRecord(raw)?.key;
      if (!key || seen.has(key)) {
        throw new Error('The child listing contained a missing or repeated key, so it could not be verified complete.');
      }
      seen.add(key);
      children.push(raw);
    }
    const more = page.totalResults > children.length;
    if (!page.data.length) {
      if (more) throw new Error('The child listing ended before all reported items were read.');
      return children;
    }
    if (!more && page.data.length < limit) return children;
  }
}

/**
 * Preview and write both read the copy the merge WRITES to, through the writer: the desktop
 * app's when it takes this library's writes, the cloud's otherwise. A preview computed from
 * one copy while the write is computed from the other is a preview of a different merge (an
 * unsynced abstract makes the plan fill a field the caller was shown as occupied, an
 * unsynced attachment makes it promise a reparenting that never happens), and the versions
 * a plan carries mean nothing to the other API.
 */
function writerReader(writer: LibraryWriter): Reader {
  return {
    getItem: (key) => writer.getItem(key),
    getChildren: (key) => allChildren((start, limit) => writer.getChildren(key, { start, limit })),
  };
}

/** Why the cloud would refuse this merge's writes to `lib`, or undefined when it would take them. */
function cloudWriteRefusal(ctx: ToolContext, lib: LibraryRef): string | undefined {
  try {
    requireCloud(ctx, lib);
    return undefined;
  } catch (e) {
    return message(e);
  }
}

/**
 * The OTHER copy, asked only for a second opinion on which children hang off a duplicate:
 * the desktop app's when the merge writes to the cloud, the cloud's when it writes to the
 * desktop. Null when there is no other copy to ask.
 */
function otherCopy(ctx: ToolContext, writer: LibraryWriter): { reader: Reader; name: string; missingFrom: string } | null {
  const lib = writer.lib;
  if (writer.target === 'cloud') {
    if (!ctx.router.servesLocally(lib)) return null;
    const local = ctx.local;
    // The desktop itself, not `ctx.router`: while a cloud write to this library waits for the
    // app to sync, the router answers its reads from the cloud, and that is now the usual
    // reason a merge lands on the cloud with the app up, so the "second opinion" would have
    // been the cloud agreeing with itself and a child added in the app would be missed.
    return {
      name: 'The Zotero desktop app',
      missingFrom: 'the cloud copy does not have yet',
      reader: local
        ? {
            getItem: (key) => local.getItem(key, {}, lib),
            getChildren: (key) => allChildren((start, limit) => local.getItemChildren(key, { start, limit }, lib)),
          }
        : {
            getItem: (key) => ctx.router.getItem(key, { library: lib }),
            getChildren: (key) => allChildren((start, limit) => ctx.router.getItemChildren(key, { library: lib, start, limit })),
          },
    };
  }
  if (!ctx.capabilities.cloud) return null;
  return {
    name: 'The Zotero cloud',
    missingFrom: 'the desktop app does not have yet',
    reader: {
      getItem: (key) => ctx.web.getItem(lib, key),
      getChildren: (key) => allChildren((start, limit) => ctx.web.getItemChildren(lib, key, { start, limit })),
    },
  };
}

/** Retry metadata conflicts only while the child still belongs to the planned duplicate. */
async function reparentChild(writer: LibraryWriter, child: ChildRecord, masterKey: string): Promise<number> {
  const patch = { parentItem: masterKey };
  try {
    return await writer.patchItem(child.key, patch, child.version!);
  } catch (e) {
    if (!(e instanceof ZoteroApiError) || e.status !== 412) throw e;
    const fresh = toRecord(await writer.getItem(child.key));
    if (!fresh || fresh.version == null) throw e;
    if (fresh.data.deleted || fresh.data.parentItem !== child.from) {
      throw new Error(`Child ${child.key} was deleted or moved to a different parent during the merge; its new state was preserved.`);
    }
    return await writer.patchItem(child.key, patch, fresh.version);
  }
}

/** The master's PATCH, and the plan it carried if a conflict forced that plan to be rebuilt. */
interface MasterPatched {
  version: number;
  replanned?: { plan: MergePlan; patch: Record<string, unknown> };
}

/**
 * The master's PATCH, RECOMPUTED rather than replayed when the record moved under us.
 *
 * A 412 is proof the master changed between the read the plan was computed from and this
 * write, and the plan is not a literal instruction: every scalar in it is there because that
 * field was empty at read time, and `tags`, `collections` and `relations` are whole arrays
 * built from that same read, because PATCH replaces an array rather than merging it.
 * Re-sending it at the new version would therefore overwrite the abstract the user just
 * typed and delete the tag they just added, which is precisely the loss this tool promises
 * never to cause, and the trash holds the duplicate, not the master's previous values.
 *
 * So the master is read again and the plan rebuilt against the record as it now is. The
 * never-overwrite rule is then applied to the state that actually exists, and the caller is
 * told the plan it gets back is the rebuilt one.
 */
async function patchMaster(
  writer: LibraryWriter,
  key: string,
  patch: Record<string, unknown>,
  version: number,
  rebuild: (master: ItemRecord) => { plan: MergePlan; patch: Record<string, unknown> },
): Promise<MasterPatched> {
  try {
    return { version: await writer.patchItem(key, patch, version) };
  } catch (e) {
    if (!(e instanceof ZoteroApiError) || e.status !== 412) throw e;
    const fresh = toRecord(await writer.getItem(key));
    if (!fresh || fresh.version == null) throw e;
    if (!isMergeableRecord(fresh)) throw new Error(`Merge target ${key} is no longer an active top-level bibliographic item; retry after reviewing it.`);
    const replanned = rebuild(fresh);
    return {
      version: await writer.patchItem(key, replanned.patch, fresh.version),
      replanned,
    };
  }
}

/** What the master's item type allows, so the plan never proposes a field Zotero refuses. */
async function fieldRules(
  ctx: ToolContext,
  itemType: unknown,
): Promise<{ fieldAllowed?: (f: string) => boolean; creatorTypeAllowed?: (t: string) => boolean }> {
  if (typeof itemType !== 'string' || !itemType) return {};
  try {
    const schema = await ctx.schema?.getSchema?.();
    const def = schema?.itemTypes?.find((t) => t.itemType === itemType);
    if (!def) return {};
    const fields = new Set((def.fields ?? []).map((f) => f.field));
    const creatorTypes = new Set((def.creatorTypes ?? []).map((c) => c.creatorType));
    // An item type with no declared fields tells us nothing; filtering on it would strip
    // every field rather than the invalid ones.
    if (!fields.size) return {};
    return {
      fieldAllowed: (f) => fields.has(f),
      creatorTypeAllowed: (t) => (creatorTypes.size ? creatorTypes.has(t) : true),
    };
  } catch {
    // The schema is a network read. Without it nothing is filtered and Zotero itself
    // refuses an impossible field, which fails the merge before anything is trashed.
    return {};
  }
}

/** The versions a plan was computed from: what a caller hands back to approve exactly that plan. */
interface PlanVersions {
  master?: number;
  duplicates: Record<string, number>;
  children: Record<string, number>;
}

/** What the caller asserted the versions were; every part optional, checked only when given. */
interface ExpectedVersions {
  master?: number;
  duplicates?: Record<string, number>;
  children?: Record<string, number>;
}

interface VersionChange {
  key: string;
  role: 'master' | 'duplicate' | 'child';
  expected?: number;
  actual?: number;
}

function planVersions(master: ItemRecord, duplicates: ItemRecord[], children: ChildRecord[]): PlanVersions {
  const known = (records: Array<{ key: string; version?: number }>): Record<string, number> =>
    Object.fromEntries(records.flatMap((r) => (r.version == null ? [] : [[r.key, r.version]])));
  return { master: master.version, duplicates: known(duplicates), children: known(children) };
}

/**
 * Every record that is not where the caller's preview left it.
 *
 * The plan the write computes is built from a fresh read, and nothing else ties that read
 * to the preview the caller approved: a duplicate edited in between is trashed with the
 * edits, a note moved under it in between is moved again, and the answer's `plan` differs
 * from the preview with no flag. The intra-call 412 handling cannot see any of that, because
 * the write's own read already reflects it. So the caller's copy of the versions is the tie,
 * and any record it names that has moved, or any child that has come or gone, stops the
 * write before it starts.
 */
function staleSince(expected: ExpectedVersions, actual: PlanVersions, masterKey: string): VersionChange[] {
  const changed: VersionChange[] = [];
  if (expected.master !== undefined && expected.master !== actual.master) {
    changed.push({ key: masterKey, role: 'master', expected: expected.master, actual: actual.master });
  }
  for (const [key, version] of Object.entries(expected.duplicates ?? {})) {
    if (actual.duplicates[key] !== version) changed.push({ key, role: 'duplicate', expected: version, actual: actual.duplicates[key] });
  }
  if (expected.children) {
    for (const [key, version] of Object.entries(expected.children)) {
      if (actual.children[key] !== version) changed.push({ key, role: 'child', expected: version, actual: actual.children[key] });
    }
    for (const [key, version] of Object.entries(actual.children)) {
      if (!(key in expected.children)) changed.push({ key, role: 'child', actual: version });
    }
  }
  return changed;
}

function describeChange(c: VersionChange): string {
  const what =
    c.expected !== undefined && c.actual !== undefined
      ? `version ${c.expected} is now ${c.actual}`
      : c.expected === undefined
        ? 'appeared under a duplicate since the preview'
        : c.role === 'child'
          ? 'no longer hangs off a duplicate'
          : 'could not be read, or is no longer a mergeable item';
  return `${c.key} (${c.role}): ${what}`;
}

const plannedField = z
  .object({
    before: z.unknown().describe('Value the master carries now: always empty, since nothing else is touched.'),
    after: z.unknown().describe('Value a duplicate would supply.'),
    from: z.string().describe('Key of the duplicate the value comes from.'),
  })
  .passthrough();

/**
 * Merge duplicate items into one master record.
 *
 * Previewing is the default here, the opposite of `zotero_update_item`, because this tool
 * both edits a record and trashes others: the caller has to ask for the write, not remember
 * to ask for the preview.
 */
const mergeItems: ToolDefinition = {
  name: 'zotero_merge_items',
  title: 'Merge duplicate items',
  description:
    'Merge one or more duplicate items into a master item: fields the master is MISSING are filled from the duplicates, their tags, collections and relations are unioned onto it, their child notes and attachments are reparented to it, and the emptied duplicates are moved to the trash (recoverable). A field the master already has is never overwritten, and nothing is ever deleted outright. PREVIEWS BY DEFAULT: with `dry_run` unset or true nothing is written and the answer is the exact plan, field by field, so the caller can see what would change before it changes. Pass `dry_run:false` to execute. The merge runs on the running Zotero desktop app (Zotero 10+, no cloud key needed) for your personal library and any group library the app holds, and on the cloud Web API (ZOTERO_API_KEY with write access) otherwise; the preview reads the same copy the write will act on, so the two cannot describe different merges, and says which (`readFrom`). The preview also reports `versions` (the master\'s, each duplicate\'s and each child\'s): pass that block back as `expect_versions` with dry_run:false and the write runs only if every record is still at that version, otherwise NOTHING is written and the answer is the plan as it now stands, as a dry run, with `changed` naming what moved. Without `expect_versions` the write plans from the records as they are at call time. If the master changes between the read and the PATCH inside one call, the plan is rebuilt against the record as it then is rather than replayed, and the answer says so (`replanned`), because replaying it would overwrite exactly what changed. Find candidates with zotero_import `check_duplicates:true`, or by comparing records yourself with zotero_search_items and zotero_get_item. The master keeps its own key, so citations already pointing at it stay valid; the duplicates keep theirs in the trash until it is emptied, and the master records a dc:replaces relation naming each item it absorbed, which is the same relation Zotero\'s own merge writes. Put a duplicate back with zotero_trash_items action:"restore"; to edit one item rather than fold two together, use zotero_update_item.',
  inputSchema: {
    master_key: z.string().describe('8-character key of the item to keep. It keeps its key, so existing citations to it stay valid.'),
    duplicate_keys: z
      .array(z.string())
      .min(1)
      .describe('8-character keys of the duplicates to fold into the master and then trash.'),
    dry_run: z
      .boolean()
      .optional()
      .describe('Preview the plan without writing anything. DEFAULT TRUE: pass false to actually merge.'),
    confirm: z.boolean().optional().describe('Required when merging more items at once than this server\'s bulk-write threshold allows.'),
    expect_versions: z
      .object({
        master: z.number().int().nonnegative().optional().describe("The master's version as the preview reported it (`versions.master`)."),
        duplicates: z
          .record(z.number().int().nonnegative())
          .optional()
          .describe("Each duplicate's version as the preview reported it (`versions.duplicates`)."),
        children: z
          .record(z.number().int().nonnegative())
          .optional()
          .describe('Each child item the preview planned to move, with its version (`versions.children`). A child that has since appeared under a duplicate, or left one, counts as a change.'),
      })
      .optional()
      .describe(
        'The `versions` block of the preview being approved. With it, dry_run:false writes only if every record named is still at that version; otherwise NOTHING is written and the answer is the plan as it now stands, as a dry run, with `changed` naming what moved. Without it the write plans from the records as they are at call time, so pass it whenever a preview was shown to someone before the write.',
      ),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      master_key: z.string().describe('The item that was kept, or would be kept.'),
      dryRun: z.boolean().describe('True when nothing was written.'),
      plan: z
        .object({
          masterTitle: z.string().optional().describe("The master's title, so the caller can confirm the right item was chosen."),
          fields: z
            .record(plannedField)
            .describe('Fields empty on the master that a duplicate can fill; only these are touched.'),
          fieldsSkipped: z
            .array(
              z
                .object({
                  field: z.string().describe('Field that was not carried over.'),
                  from: z.string().describe('Duplicate that held it.'),
                  reason: z.string().describe('Why it was left behind, e.g. the master\'s item type has no such field.'),
                })
                .passthrough(),
            )
            .describe('Values a duplicate holds that the merge deliberately does not copy.'),
          tagsAdded: z.array(z.string()).describe('Tags the duplicates carry that the master does not.'),
          collectionsAdded: z.array(z.string()).describe('Collection keys the duplicates belong to that the master does not.'),
          relationsAdded: z.record(z.array(z.string())).describe('Relation predicates and targets unioned onto the master, including the dc:replaces links back to the merged keys.'),
          childrenToMove: z
            .array(z.object({ key: z.string().describe('Child item key.'), itemType: z.string().optional().describe('Child type, e.g. "attachment" or "note".'), title: z.string().optional().describe('Child title or filename.'), from: z.string().describe('Duplicate the child hangs off today.') }).passthrough())
            .describe('Child notes and attachments that would be reparented to the master.'),
          duplicatesToTrash: z.array(z.string()).describe('Keys that would be moved to the trash once emptied.'),
        })
        .passthrough()
        .describe('Exactly what the merge would do, computed from the current records.'),
      applied: z
        .object({
          masterVersion: z.number().optional().describe("The master's version after the merge."),
          childrenMoved: z.array(z.string()).describe('Child keys successfully reparented.'),
          trashed: z.array(z.string()).describe('Duplicate keys successfully trashed.'),
        })
        .passthrough()
        .optional()
        .describe('What actually landed; absent on a dry run.'),
      replanned: z
        .boolean()
        .optional()
        .describe('True when the master changed between the read and the write: the plan was rebuilt against the record as it then was, so `plan` is what was actually written rather than what a preview showed.'),
      versions: z
        .object({
          master: z.number().optional().describe("The master's version the plan was computed from."),
          duplicates: z.record(z.number()).describe("Each duplicate's version the plan was computed from."),
          children: z.record(z.number()).describe('Each child item the plan would move, with the version it was read at.'),
        })
        .passthrough()
        .optional()
        .describe('The record versions this plan was computed from. Pass the block back as `expect_versions` with dry_run:false so the write runs only against these exact records.'),
      changed: z
        .array(
          z
            .object({
              key: z.string().describe('The record that is not at the version the caller expected.'),
              role: z.string().describe('"master", "duplicate" or "child".'),
              expected: z.number().optional().describe('The version the caller expected; absent for a child that has appeared since the preview.'),
              actual: z.number().optional().describe('The version it is at now; absent for a duplicate that could not be read or a child that has left.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('Present, with dryRun:true and nothing written, when `expect_versions` did not match what the library holds now.'),
      readFrom: z
        .string()
        .optional()
        .describe('Which copy of the library the plan was computed from, which is also the copy a merge writes to: "local" (the running Zotero desktop app, for any library it holds) or "cloud" (the Zotero Web API).'),
      note: z
        .string()
        .optional()
        .describe('Anything the caller should know before acting on this answer, e.g. that the library moved since the preview being approved.'),
      target: writeTarget,
      failed: writeFailures,
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const dryRun = args.dry_run !== false;
    const masterKey = String(args.master_key ?? '').trim();
    if (!masterKey) return err('`master_key` is empty: name the 8-character key of the item to keep.');
    const duplicateKeys: string[] = [
      ...new Set<string>(
        ((args.duplicate_keys ?? []) as unknown[]).map((k) => String(k ?? '').trim()).filter(Boolean),
      ),
    ].filter((k) => k !== masterKey);
    if (!duplicateKeys.length) {
      return err(
        `Nothing to merge into ${masterKey}: \`duplicate_keys\` named no other item. It must list the keys to fold in, not the master itself.`,
      );
    }

    const lib = resolveLibrary(ctx, args);
    // A preview writes nothing, so it must not need what only a write needs. Without this, a
    // dry run with the desktop not taking this library's writes (app down, group not held,
    // sync pending) went through the cloud write gate and was refused for a key that is
    // read-only, or absent, although reading is all a preview does.
    // Only when some copy can be read at all: with no key and no desktop serving the library
    // there is nothing to preview, and the write gate's "nowhere to go" is the answer.
    if (dryRun && !(await desktopTakesWrites(ctx, lib))) {
      const cannotApply = cloudWriteRefusal(ctx, lib);
      const readable = Boolean(ctx.capabilities.cloud) || ctx.router.servesLocally(lib);
      if (cannotApply && readable) {
        return runMerge(ctx, args, previewWriter(ctx, lib), masterKey, duplicateKeys, true, cannotApply);
      }
    }
    return withLibraryWriter(ctx, lib, (writer) => runMerge(ctx, args, writer, masterKey, duplicateKeys, dryRun));
  },
};

/**
 * One merge, planned and (unless `dryRun`) applied on ONE copy of the library: the one
 * `writer` writes to. Every read the plan rests on, every version it sends and the final
 * library-version pin come from that same API, which is what keeps the consistency
 * guarantees below true on the desktop app as much as on the cloud: the desktop's versions
 * are its own `clientVersion`s and mean nothing to the cloud, and the other way round.
 *
 * Throws `LocalWritesUnavailableError` only from the master's PATCH, the first write, so
 * `withLibraryWriter` can re-run the whole merge on the cloud with nothing yet written.
 */
async function runMerge(
  ctx: ToolContext,
  args: any,
  writer: LibraryWriter,
  masterKey: string,
  duplicateKeys: string[],
  dryRun: boolean,
  /** Set for a preview no API here could apply: why, so the answer can say so. */
  cannotApply?: string,
): Promise<ToolHandlerResult> {
  const lib = writer.lib;
  const read = writerReader(writer);
  const failed: { key?: string; code?: number; message?: string }[] = [];

  let rawMaster: any;
  try {
    rawMaster = await read.getItem(masterKey);
  } catch (e) {
    return err(`Could not read the master item ${masterKey}: ${message(e)}`);
  }
  const master = toRecord(rawMaster);
  if (!master) return err(`No item ${masterKey} in this library, so there is nothing to merge into.`);
  if (!isMergeableRecord(master)) return err(`Item ${masterKey} is not an active top-level bibliographic item. Notes, attachments, annotations and trashed items cannot be merge targets; nothing was written.`);

  const duplicates: ItemRecord[] = [];
  for (const key of duplicateKeys) {
    try {
      const rec = toRecord(await read.getItem(key));
      if (rec && !isMergeableRecord(rec)) {
        failed.push({ key, message: `Item ${key} is not an active top-level bibliographic item, so it was excluded from the merge.` });
      } else if (rec) duplicates.push(rec);
      else failed.push({ key, message: `No item ${key} in this library.` });
    } catch (e) {
      failed.push({ key, code: statusOf(e), message: `Could not read ${key}: ${message(e)}` });
    }
  }
  if (!duplicates.length) {
    return err(
      `None of the duplicates could be read (${failed.map((f) => f.message).join(' ')}), so no plan could be built and nothing was written.`,
    );
  }

  // A duplicate whose children could not be listed must not be trashed: an attachment left
  // hanging off it would go into the trash with it.
  const unsafeToTrash = new Set<string>();
  const children: ChildRecord[] = [];
  for (const dup of duplicates) {
    try {
      for (const raw of await read.getChildren(dup.key)) {
        const child = toChild(raw, dup.key);
        if (child) children.push(child);
      }
    } catch (e) {
      unsafeToTrash.add(dup.key);
      failed.push({
        key: dup.key,
        code: statusOf(e),
        message: `Could not list the child items of ${dup.key} (${message(e)}), so it was left out of the trash.`,
      });
    }
  }

  // The write goes to one copy, but the other may still be holding a child this one has
  // never seen: an attachment saved in the desktop app a minute ago hangs off the duplicate
  // there and nowhere else, and one added on another computer is on the cloud and not yet in
  // this desktop. Trashing the parent here would take that child along at the next sync. So
  // when the other copy can be asked it is, purely as a veto on the trashing. Best effort: a
  // copy that will not answer must not stop a merge this one can complete by itself.
  const other = otherCopy(ctx, writer);
  if (other) {
    for (const dup of duplicates) {
      try {
        const seen = new Set(children.filter((c) => c.from === dup.key).map((c) => c.key));
        const elsewhere = (await other.reader.getChildren(dup.key))
          .map((raw) => toChild(raw, dup.key))
          .filter((c): c is ChildRecord => !!c && !seen.has(c.key));
        if (!elsewhere.length) continue;
        unsafeToTrash.add(dup.key);
        failed.push({
          key: dup.key,
          message:
            `${other.name} lists ${elsewhere.length} child item(s) on ${dup.key} that ${other.missingFrom} ` +
            `(${elsewhere.map((c) => c.key).join(', ')}), so ${dup.key} was left out of the ` +
            'trash: trashing it now would take them with it once Zotero syncs. Let Zotero finish syncing ' +
            '(zotero_sync) and merge again.',
        });
      } catch {
        // The other copy is a second opinion here, not the source of truth.
      }
    }
  }

  // What the plan is computed from, so a caller can hand it back and approve THIS plan and
  // not whatever a later read produces.
  const versions = planVersions(master, duplicates, children);

  const rules = await fieldRules(ctx, master.data.itemType);
  const itemUri = itemUriFor(ctx, lib, recordUserId(rawMaster));
  const planFor = (m: ItemRecord): { plan: MergePlan; patch: Record<string, unknown> } =>
    buildMergePlan({
      master: m,
      duplicates,
      children,
      itemUri,
      unsafeToTrash,
      ...rules,
    });
  // Rebuilt in place if the master turns out to have moved under the merge; `structured()`
  // and the summary both read these at return time, so the caller is shown what was written.
  let { plan, patch } = planFor(master);
  const filled = (): string =>
    `${Object.keys(plan.fields).length} field(s), ${plan.tagsAdded.length} tag(s) and ${plan.collectionsAdded.length} collection(s)`;
  const where = writer.target === 'local' ? ' in the Zotero desktop app' : '';

  if (dryRun) {
    return okLibraryContent(
      {
        master_key: masterKey,
        dryRun: true,
        plan,
        versions,
        readFrom: writer.target,
        note: cannotApply ? `Preview only: this server cannot apply this merge. ${cannotApply}` : undefined,
        failed: failed.length ? failed : undefined,
      },
      (cannotApply ? 'Preview only, this server cannot apply it (see note). ' : '') +
      `Dry run: merging ${duplicates.length} item(s) into ${masterKey}${where} would fill ${filled()}, ` +
        `move ${plan.childrenToMove.length} child item(s), and trash ${plan.duplicatesToTrash.length} item(s). ` +
        'Nothing was written. To run exactly this plan, pass `versions` back as `expect_versions` with dry_run:false.' +
        (plan.fieldsSkipped.length ? ` ${plan.fieldsSkipped.length} value(s) would be left behind; see plan.fieldsSkipped.` : '') +
        (failed.length ? ` ${failed.length} item(s) could not be planned in full; see failed.` : ''),
    );
  }

  // The plan that was approved is the plan that runs, and this is what makes that true
  // across two calls: the write is refused, and the fresh plan handed back as a preview,
  // when any record the caller's preview was computed from has moved since.
  const changed = args.expect_versions ? staleSince(args.expect_versions as ExpectedVersions, versions, masterKey) : [];
  if (changed.length) {
    const note =
      'Nothing was written: the library moved since the preview that `expect_versions` describes, so that plan ' +
      'is no longer the plan. This answer is the plan as it now stands; review it and pass its `versions` as ' +
      '`expect_versions` to run it.';
    return okLibraryContent(
      {
        master_key: masterKey,
        dryRun: true,
        plan,
        versions,
        changed,
        readFrom: writer.target,
        note,
        failed: failed.length ? failed : undefined,
      },
      `Nothing was written: ${changed.length} record(s) changed since the preview (${changed.map(describeChange).join('; ')}). ` +
        `Merging ${duplicates.length} item(s) into ${masterKey}${where} would NOW fill ${filled()}, ` +
        `move ${plan.childrenToMove.length} child item(s), and trash ${plan.duplicatesToTrash.length} item(s); ` +
        'review this plan and pass its `versions` back as `expect_versions` to run it.' +
        (plan.fieldsSkipped.length ? ` ${plan.fieldsSkipped.length} value(s) would be left behind; see plan.fieldsSkipped.` : '') +
        (failed.length ? ` ${failed.length} item(s) could not be planned in full; see failed.` : ''),
    );
  }

  const attempted = 1 + children.length + duplicates.length;
  // Gated here rather than on `duplicate_keys` alone: this call PATCHes the master and
  // every child as well as trashing the duplicates, and a gate that counts two of those
  // and ignores a hundred is not the gate the operator switched on.
  const refusal = requireBulkConfirm(ctx, attempted, 'merge', args.confirm);
  if (refusal) return refusal;
  let replanned = false;
  const structured = (extra: Record<string, unknown>): Record<string, unknown> => ({
    master_key: masterKey,
    dryRun: false,
    plan,
    readFrom: writer.target,
    ...(replanned ? { replanned: true } : {}),
    target: writer.target,
    failed,
    provenance: LIBRARY_CONTENT_PROVENANCE,
    ...extra,
  });

  if (master.version == null) {
    return err(
      `Could not determine the current version of ${masterKey}, and a merge will not PATCH without one. Nothing was written.`,
    );
  }

  let masterVersion: number;
  try {
    const written = await patchMaster(writer, masterKey, patch, master.version, planFor);
    masterVersion = written.version;
    if (written.replanned) {
      replanned = true;
      plan = written.replanned.plan;
      patch = written.replanned.patch;
    }
  } catch (e) {
    // The desktop turned out not to take writes, and this was the first one: nothing has
    // landed, so the whole merge starts over on the cloud, reading the cloud's copy.
    if (mustFallBack(e)) throw e;
    failed.push({ key: masterKey, code: statusOf(e), message: `Updating the master failed: ${message(e)}` });
    // Nothing downstream ran, so the plan must not go on claiming a trashing that will
    // now never happen.
    plan.duplicatesToTrash = [];
    return writeResult(
      structured({ applied: { childrenMoved: [], trashed: [] } }),
      `Merging into ${masterKey} stopped at the first step: the master could not be updated, so no child item was moved and nothing was trashed.`,
      0,
      attempted,
      failed,
    );
  }

  const childrenMoved: string[] = [];
  for (const child of children) {
    if (child.version == null) {
      unsafeToTrash.add(child.from);
      failed.push({ key: child.key, message: `No version for child ${child.key}, so it was not reparented.` });
      continue;
    }
    try {
      await reparentChild(writer, child, masterKey);
      childrenMoved.push(child.key);
    } catch (e) {
      const status = statusOf(e);
      unsafeToTrash.add(child.from);
      failed.push({
        key: child.key,
        code: status,
        message:
          `Reparenting ${child.key} onto ${masterKey} failed: ${message(e)}` +
          (status === 400 || status === 403
            ? ' The API refused a parentItem change on an existing child item.'
            : '') +
          ` ${child.from} was left out of the trash so the child is not trashed with it.`,
      });
    }
  }

  const trashable = duplicates.filter((d) => !unsafeToTrash.has(d.key) && d.version != null);
  // A reparenting failure above can rule a duplicate out after the plan was built, so the
  // plan is brought back into line with what this run has actually decided to do before it
  // is handed back next to the failures that decided it.
  plan.duplicatesToTrash = trashable.map((d) => d.key);
  for (const d of duplicates) {
    if (!unsafeToTrash.has(d.key) && d.version == null) {
      failed.push({ key: d.key, message: `No version for ${d.key}, so it was not trashed.` });
    }
  }
  const trashed: string[] = [];
  // Recheck immediately before each trash write. The original item version does not
  // protect against a new child: creating one need not change its parent's version (on the
  // desktop app as on the cloud, a parent is not saved when a child arrives or leaves).
  // The library version on the final POST closes the gap after this empty-child read: both
  // APIs refuse the whole POST with 412 when anything in the library moved since.
  for (const duplicate of trashable) {
    try {
      const remaining = await writer.getChildren(duplicate.key, { limit: 1 });
      if (remaining.data.length || remaining.totalResults > 0) {
        throw new Error('Child items remain or appeared during the merge; retry after reviewing them.');
      }
      if (!Number.isSafeInteger(remaining.lastModifiedVersion) || remaining.lastModifiedVersion <= 0) {
        throw new Error('The child listing did not supply a library version, so an empty parent could not be safely confirmed.');
      }
      const result = await writer.writeItems(
        [{ key: duplicate.key, version: duplicate.version, deleted: 1 }],
        { libraryVersion: remaining.lastModifiedVersion },
      );
      trashed.push(...result.successful.map((s) => s.key), ...result.unchanged);
      failed.push(...result.failed);
    } catch (e) {
      failed.push({ key: duplicate.key, code: statusOf(e), message: `Trashing ${duplicate.key} was refused: ${message(e)}` });
    }
  }
  plan.duplicatesToTrash = [...trashed];

  const succeeded = 1 + childrenMoved.length + trashed.length;
  const left = duplicates.length - trashed.length;
  return writeResult(
    structured({ applied: { masterVersion, childrenMoved, trashed } }),
    `Merged ${trashed.length} of ${duplicates.length} duplicate(s) into ${masterKey}${where ? ' via the Zotero desktop app' : ''}: filled ${filled()}, ` +
      `moved ${childrenMoved.length} of ${children.length} child item(s).` +
      (replanned
        ? ` ${masterKey} changed ${writer.target === 'local' ? 'in the desktop app' : 'on the server'} while this merge was being planned, so the plan was rebuilt` +
          ' against the record as it then was and `plan` describes what was written, not what a preview showed.'
        : '') +
      (left
        ? ` ${left} duplicate(s) stayed in the library because something on them did not move; see failed.`
        : ' The merged duplicates are in the Zotero trash and can be restored from there.'),
    succeeded,
    attempted,
    failed,
  );
}

export default mergeItems;
