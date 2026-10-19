import type { ToolContext } from '../registry/registry.js';
import { desktopTakesWrites, isLocalWritesUnavailable, requireCloud } from '../registry/registry.js';
import type { LibraryRef, ListResult, WriteResult } from '../api/web-client.js';
import type { LocalWriteClient } from '../api/local-writes.js';

/**
 * One library's write surface, on whichever API is taking its writes: the running Zotero
 * desktop app (local API, Zotero 10+) or the cloud Web API.
 *
 * The reads here are the ones a write needs (the version to send, the record to merge a
 * patch into), and they come from the SAME API the write goes to. That is not tidiness:
 * Zotero checks a write's version against its own copy, and the desktop's versions are its
 * local `clientVersion`s, which have nothing to do with the cloud's. A version read from one
 * and sent to the other is a 412 at best and a silently accepted stale write at worst.
 */
export interface LibraryWriter {
  /** Where the writes go, as `target` reports it: "local" (desktop local API) or "cloud". */
  readonly target: 'local' | 'cloud';
  readonly lib: LibraryRef;
  getItem(key: string): Promise<any>;
  /** One page of an item's direct children (notes and attachments), with the library version it was read at. */
  getChildren(key: string, page: { start?: number; limit?: number }): Promise<ListResult>;
  /** One collection in `{ key, version, data }` shape, or null when there is none. */
  getCollection(key: string): Promise<any | null>;
  /**
   * `opts.libraryVersion` pins the write to that library version: refused with 412 if
   * anything in the library moved since, on either API.
   */
  writeItems(objects: Record<string, unknown>[], opts?: { libraryVersion?: number }): Promise<WriteResult>;
  writeCollections(objects: Record<string, unknown>[]): Promise<WriteResult>;
  writeSearches(objects: Record<string, unknown>[]): Promise<WriteResult>;
  /** PATCH one item at its own version; 412 (a ZoteroApiError) when it changed since. */
  patchItem(key: string, patch: Record<string, unknown>, version: number): Promise<number>;
  deleteCollections(keys: string[]): Promise<void>;
  deleteSearches(keys: string[]): Promise<void>;
  setFullText(
    key: string,
    body: { content: string; indexedChars?: number; totalChars?: number; indexedPages?: number; totalPages?: number },
  ): Promise<void>;
}

/**
 * The running desktop app does not take local-API writes after all (Zotero 9's read-only
 * local API, a grant that is gone, an app that quit), and nothing has been written through
 * it yet, so the whole operation can safely run again on the cloud.
 *
 * Its own class because the test that decides it, `isLocalWritesUnavailable`, reads the
 * message, and the desktop's READS fail with messages of the same shape: a missing item is
 * "Local API 404 for /users/0/items/X". Raised only from the writer's write calls, a missing
 * item can never be mistaken for a missing write endpoint and sent to the cloud.
 */
export class LocalWritesUnavailableError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'LocalWritesUnavailableError';
  }
}

/**
 * For a per-object loop that collects failures instead of throwing: true when this error
 * must leave the loop so the whole operation falls back to the cloud. Only ever true before
 * the first desktop write landed, so a loop that rethrows it has written nothing.
 */
export function mustFallBack(err: unknown): boolean {
  return err instanceof LocalWritesUnavailableError;
}

function cloudWriter(ctx: ToolContext, lib: LibraryRef): LibraryWriter {
  return {
    target: 'cloud',
    lib,
    getItem: (key) => ctx.web.getItem(lib, key),
    getChildren: (key, page) => ctx.web.getItemChildren(lib, key, page),
    getCollection: (key) => ctx.web.getCollection(lib, key),
    writeItems: (objects, opts) => (opts ? ctx.web.writeItems(lib, objects, opts) : ctx.web.writeItems(lib, objects)),
    writeCollections: (objects) => ctx.web.writeCollections(lib, objects),
    writeSearches: (objects) => ctx.web.writeSearches(lib, objects),
    patchItem: (key, patch, version) => ctx.web.patchItem(lib, key, patch, version),
    deleteCollections: async (keys) => ctx.web.deleteCollections(lib, keys, await ctx.web.currentLibraryVersion(lib)),
    deleteSearches: async (keys) => ctx.web.deleteSearches(lib, keys, await ctx.web.currentLibraryVersion(lib)),
    setFullText: (key, body) => ctx.web.setFullText(lib, key, body),
  };
}

function localWriter(ctx: ToolContext, lib: LibraryRef, client: LocalWriteClient): LibraryWriter & { landed: boolean } {
  const writer = {
    target: 'local' as const,
    lib,
    landed: false,
    getItem: (key: string) => (ctx.local ? ctx.local.getItem(key, {}, lib) : ctx.router.getItem(key, { library: lib })),
    getChildren: (key: string, page: { start?: number; limit?: number }) =>
      ctx.local
        ? ctx.local.getItemChildren(key, page, lib)
        : ctx.router.getItemChildren(key, { library: lib, ...page }),
    getCollection: (key: string) => (ctx.local ? ctx.local.getCollection(key, lib) : ctx.router.getCollection(key, { library: lib })),
    writeItems: (objects: Record<string, unknown>[], opts?: { libraryVersion?: number }) =>
      write(() => (opts ? client.writeItems(objects, lib, opts) : client.writeItems(objects, lib))),
    writeCollections: (objects: Record<string, unknown>[]) => write(() => client.writeCollections(objects, lib)),
    writeSearches: (objects: Record<string, unknown>[]) => write(() => client.writeSearches(objects, lib)),
    patchItem: (key: string, patch: Record<string, unknown>, version: number) =>
      write(() => client.patchItem(key, patch, version, lib)),
    deleteCollections: (keys: string[]) => write(() => client.deleteCollections(keys, lib)),
    deleteSearches: (keys: string[]) => write(() => client.deleteSearches(keys, lib)),
    setFullText: (key: string, body: Parameters<LibraryWriter['setFullText']>[1]) =>
      write(() => client.setFullText(key, body, lib)),
  };
  async function write<T>(op: () => Promise<T>): Promise<T> {
    try {
      const out = await op();
      writer.landed = true;
      return out;
    } catch (e) {
      // After a write has landed on the desktop, re-running the operation on the cloud would
      // apply it twice once the two sync (a second collection, a duplicate item), so from
      // then on a failure is just a failure.
      if (!writer.landed && isLocalWritesUnavailable(e)) throw new LocalWritesUnavailableError(e);
      throw e;
    }
  }
  return writer;
}

/**
 * A writer that only reads, for a preview this server could not apply: no desktop taking the
 * library's writes and no cloud key allowed to. Its reads are routed like any other read
 * (the desktop when it serves the library, the cloud otherwise), and `target` says which, so
 * the preview still names the copy it describes. Every write refuses, so a caller that
 * forgot it was previewing cannot reach either API through it.
 */
export function previewWriter(ctx: ToolContext, lib: LibraryRef): LibraryWriter {
  const refuse = async (): Promise<never> => {
    throw new Error('This writer only previews: nothing here can take a write to this library.');
  };
  return {
    target: ctx.router.servesLocally(lib) ? 'local' : 'cloud',
    lib,
    getItem: (key) => ctx.router.getItem(key, { library: lib }),
    getChildren: (key, page) => ctx.router.getItemChildren(key, { library: lib, ...page }),
    getCollection: (key) => ctx.router.getCollection(key, { library: lib }),
    writeItems: refuse,
    writeCollections: refuse,
    writeSearches: refuse,
    patchItem: refuse,
    deleteCollections: refuse,
    deleteSearches: refuse,
    setFullText: refuse,
  };
}

/**
 * Run a write operation against `lib` on the running desktop app when it can take it, and
 * on the cloud Web API otherwise. The order every desktop-capable write tool already used
 * (`zotero_trash_items`, `zotero_delete_items`, `zotero_annotate`), shared so the rest stop
 * demanding a cloud key the desktop makes unnecessary.
 *
 * The desktop is tried for every library it holds (the personal one, and each group in
 * `capabilities.localGroupIds`), only when it is up, and not while a cloud write to that
 * library is waiting for it to sync: see `desktopTakesWrites`. If it turns out not to take
 * writes before anything was written, `run` starts over on the cloud, which `requireCloud`
 * gates with the reason there is no cloud to fall back to.
 */
export async function withLibraryWriter<T>(
  ctx: ToolContext,
  lib: LibraryRef,
  run: (writer: LibraryWriter) => Promise<T>,
): Promise<T> {
  if (ctx.localWrites && (await desktopTakesWrites(ctx, lib))) {
    try {
      return await run(localWriter(ctx, lib, ctx.localWrites));
    } catch (e) {
      if (!(e instanceof LocalWritesUnavailableError)) throw e;
      ctx.logger.info(`Local-API writes unavailable (${e.message}); falling back to the cloud Web API.`);
      if (!ctx.capabilities.cloud) throw new Error(desktopRefusedMessage(e.message));
    }
  }
  return run(cloudWriter(ctx, requireCloud(ctx, lib)));
}

/**
 * Why a personal-library write found nowhere to go when the desktop app was up but refused
 * it. requireCloud's own messages say the desktop is unreachable or the operation is
 * cloud-only, and here neither is true: the desktop answered, and said no.
 */
function desktopRefusedMessage(reason: string): string {
  return (
    `The running Zotero desktop app did not accept this write (${reason}), and no cloud API key is configured to ` +
    'take it instead. Desktop writes need Zotero 10 or newer (10.0.6 takes every desktop write Zoteus makes; ' +
    'Zotero 9 and earlier have a read-only local API) and a one-time "Always Allow" in the dialog Zotero shows the ' +
    'first time Zoteus writes. Either update Zotero and accept that dialog, or set ZOTERO_API_KEY ' +
    '(https://www.zotero.org/settings/keys) with write access.'
  );
}
