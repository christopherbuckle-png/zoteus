import { describe, it, expect, vi } from 'vitest';
import manageCollections from '../../src/tools/manage-collections.js';
import savedSearches from '../../src/tools/saved-searches.js';
import manageTags from '../../src/tools/manage-tags.js';
import createItems from '../../src/tools/create-items.js';
import updateItem from '../../src/tools/update-item.js';
import fulltext from '../../src/tools/fulltext.js';
import { ZoteroApiError } from '../../src/api/errors.js';
import { LocalApiError } from '../../src/api/local-client.js';

/**
 * Personal-library writes that Zotero 10's local API takes, and that Zoteus sent to the cloud
 * only, so a desktop-only install (no ZOTERO_API_KEY) could read its collections and not make
 * one. Measured on Zotero 10.0.6: "create a subcollection in Thesis" answered "This operation
 * writes to a cloud/group library and requires a cloud API key", with the desktop app up and
 * the local API taking that exact POST when asked directly.
 */

const ok = (key: string, version = 50) => ({
  successful: [{ index: 0, key, version }],
  unchanged: [],
  failed: [],
  newLibraryVersion: version,
});

function desktopCtx(opts: { cloud?: boolean; localApi?: boolean } = {}): any {
  const cloud = opts.cloud ?? false;
  return {
    config: { allowDelete: false },
    capabilities: {
      cloud: cloud ? { userID: 19552201, username: 'oscardvs', access: { user: { write: true } } } : null,
      localApi: opts.localApi ?? true,
    },
    schema: { validateItem: vi.fn(async () => ({ valid: true, errors: [] })) },
    router: { defaultLibrary: () => (cloud ? { type: 'user', id: 19552201 } : { type: 'user', id: 0 }) },
    // The desktop's own copies, with the desktop's own versions (its clientVersions).
    local: {
      ping: vi.fn(async () => opts.localApi ?? true),
      getItem: vi.fn(async (key: string) => ({ key, version: 2090, data: { itemType: 'book', tags: [{ tag: 'old' }], collections: ['THESIS01'] } })),
      getCollection: vi.fn(async (key: string) => ({ key, version: 2088, data: { key, version: 2088, name: 'Draft', parentCollection: false, relations: {} } })),
    },
    localWrites: {
      writeCollections: vi.fn(async () => ok('SUBCOL01')),
      writeSearches: vi.fn(async () => ok('SRCH0001')),
      writeItems: vi.fn(async () => ok('ITEM0001')),
      patchItem: vi.fn(async () => 2091),
      deleteCollections: vi.fn(async () => undefined),
      deleteSearches: vi.fn(async () => undefined),
      setFullText: vi.fn(async () => undefined),
    },
    web: {
      getItem: vi.fn(async (_lib: unknown, key: string) => ({ key, version: 7, data: { itemType: 'book', tags: [], collections: [] } })),
      getCollection: vi.fn(async () => ({ key: 'C', version: 7, data: { name: 'x' } })),
      writeCollections: vi.fn(async () => ok('CLOUDCOL', 8)),
      writeSearches: vi.fn(async () => ok('CLOUDSRC', 8)),
      writeItems: vi.fn(async () => ok('CLOUDITM', 8)),
      patchItem: vi.fn(async () => 8),
      deleteCollections: vi.fn(async () => undefined),
      deleteSearches: vi.fn(async () => undefined),
      setFullText: vi.fn(async () => undefined),
      currentLibraryVersion: vi.fn(async () => 100),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

/** What a Zotero 9 desktop (read-only local API) makes of a write. */
const zotero9 = () => new Error('Local API local write failed (501): Endpoint does not support method');

const text = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');

describe('zotero_manage_collections writes through the desktop app', () => {
  it('creates a subcollection with no cloud key (the reported failure)', async () => {
    const ctx = desktopCtx();
    const res = await manageCollections.handler(
      { action: 'create', name: 'Draft 19 Oct', parent_collection: 'THESIS01' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(ctx.localWrites.writeCollections).toHaveBeenCalledWith([{ name: 'Draft 19 Oct', parentCollection: 'THESIS01' }]);
    expect(ctx.web.writeCollections).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ created: ['SUBCOL01'], target: 'local' });
    expect(text(res)).toMatch(/inside THESIS01 via the Zotero desktop app/);
  });

  it('prefers the desktop for the personal library even when a cloud key is set', async () => {
    // The order trash, delete, annotate and import already used: desktop first, cloud second.
    const ctx = desktopCtx({ cloud: true });
    await manageCollections.handler({ action: 'create', name: 'X' }, ctx);
    expect(ctx.localWrites.writeCollections).toHaveBeenCalledWith([{ name: 'X', parentCollection: false }]);
    expect(ctx.web.writeCollections).not.toHaveBeenCalled();
  });

  it('renames with the version the DESKTOP reported, read from the desktop', async () => {
    const ctx = desktopCtx({ cloud: true });
    await manageCollections.handler({ action: 'rename', collection_key: 'COLL0001', name: 'Final' }, ctx);
    expect(ctx.local.getCollection).toHaveBeenCalledWith('COLL0001', { type: 'user', id: 19552201 });
    expect(ctx.web.getCollection).not.toHaveBeenCalled();
    const [[[obj]]] = ctx.localWrites.writeCollections.mock.calls;
    expect(obj).toMatchObject({ key: 'COLL0001', version: 2088, name: 'Final' });
  });

  it('reparents to top level, and says not found when the desktop has no such collection', async () => {
    const ctx = desktopCtx();
    await manageCollections.handler({ action: 'reparent', collection_key: 'COLL0001' }, ctx);
    expect(ctx.localWrites.writeCollections.mock.calls[0][0][0].parentCollection).toBe(false);

    ctx.local.getCollection = vi.fn(async () => null);
    const res = await manageCollections.handler({ action: 'rename', collection_key: 'NOPE0000', name: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/NOPE0000 not found/);
  });

  it('deletes through the desktop', async () => {
    const ctx = desktopCtx();
    const res = await manageCollections.handler({ action: 'delete', collection_key: 'COLL0001' }, ctx);
    expect(ctx.localWrites.deleteCollections).toHaveBeenCalledWith(['COLL0001']);
    expect(res.structuredContent).toMatchObject({ deleted: 'COLL0001', target: 'local' });
  });

  it('adds items by patching each at its own desktop version', async () => {
    const ctx = desktopCtx();
    const res = await manageCollections.handler(
      { action: 'add_items', collection_key: 'SUBCOL01', item_keys: ['AAAA1111', 'BBBB2222'] },
      ctx,
    );
    expect(ctx.localWrites.patchItem).toHaveBeenCalledWith('AAAA1111', { collections: ['THESIS01', 'SUBCOL01'] }, 2090);
    expect(ctx.localWrites.patchItem).toHaveBeenCalledTimes(2);
    expect(res.structuredContent).toMatchObject({ updated: ['AAAA1111', 'BBBB2222'], target: 'local' });
  });

  it('checks its arguments before reaching for either API', async () => {
    const ctx = desktopCtx({ localApi: false });
    const res = await manageCollections.handler({ action: 'create' }, ctx);
    expect(text(res)).toMatch(/`name` is required/);
  });
});

describe('falling back from the desktop to the cloud', () => {
  it('falls back when the running Zotero has no local-API writes', async () => {
    const ctx = desktopCtx({ cloud: true });
    ctx.localWrites.writeCollections = vi.fn(async () => {
      throw zotero9();
    });
    const res = await manageCollections.handler({ action: 'create', name: 'X' }, ctx);
    expect(ctx.web.writeCollections).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, [{ name: 'X', parentCollection: false }]);
    expect(res.structuredContent).toMatchObject({ created: ['CLOUDCOL'], target: 'cloud' });
  });

  it('falls back out of a per-item loop when the very first write is refused', async () => {
    const ctx = desktopCtx({ cloud: true });
    ctx.localWrites.patchItem = vi.fn(async () => {
      throw zotero9();
    });
    const res = await manageTags.handler({ action: 'add', tags: ['t'], item_keys: ['AAAA1111', 'BBBB2222'] }, ctx);
    expect(ctx.localWrites.patchItem).toHaveBeenCalledTimes(1);
    expect(ctx.web.patchItem).toHaveBeenCalledTimes(2);
    // Re-read from the cloud, at the cloud's version, not the desktop's.
    expect(ctx.web.patchItem).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, 'AAAA1111', { tags: [{ tag: 't' }] }, 7);
    expect(res.structuredContent).toMatchObject({ updated: ['AAAA1111', 'BBBB2222'], target: 'cloud' });
  });

  it('never falls back once a desktop write has landed, which would apply it twice', async () => {
    const ctx = desktopCtx({ cloud: true });
    let n = 0;
    ctx.localWrites.patchItem = vi.fn(async () => {
      if (++n === 1) return 2091;
      throw new Error('Local API unreachable (HTTP 503) - is Zotero running?');
    });
    const res = await manageCollections.handler(
      { action: 'add_items', collection_key: 'SUBCOL01', item_keys: ['AAAA1111', 'BBBB2222'] },
      ctx,
    );
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ updated: ['AAAA1111'], target: 'local' });
    expect((res.structuredContent as any).failed[0]).toMatchObject({ key: 'BBBB2222' });
  });

  it('treats a missing item on the desktop as a missing item, not a missing write endpoint', async () => {
    // The desktop answers a read of an unknown key with "Local API 404 for /users/0/items/X",
    // which the unavailability test reads as a Zotero 9 "no endpoint". Sent to the cloud, a
    // key the desktop does not hold would be looked for in the wrong copy.
    const ctx = desktopCtx({ cloud: true });
    ctx.local.getItem = vi.fn(async (key: string) => {
      throw new LocalApiError(404, `Local API 404 for /users/0/items/${key}`);
    });
    const res = await manageTags.handler({ action: 'add', tags: ['t'], item_keys: ['GONE0000'] }, ctx);
    expect(ctx.web.getItem).not.toHaveBeenCalled();
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect((res.structuredContent as any).failed[0]).toMatchObject({ key: 'GONE0000' });
  });

  it('does not route around a write the desktop really rejected', async () => {
    const ctx = desktopCtx({ cloud: true });
    ctx.localWrites.writeItems = vi.fn(async () => {
      throw new Error('Local API local write failed (400): itemType property not provided');
    });
    await expect(createItems.handler({ items: [{ itemType: 'book', title: 'T' }] }, ctx)).rejects.toThrow(/400/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('says the desktop refused, not that it is missing, when there is no key to fall back to', async () => {
    const ctx = desktopCtx();
    ctx.localWrites.writeCollections = vi.fn(async () => {
      throw zotero9();
    });
    const err = await manageCollections.handler({ action: 'create', name: 'X' }, ctx).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not accept this write/);
    expect((err as Error).message).toMatch(/Zotero 10 or newer/);
    expect(ctx.web.writeCollections).not.toHaveBeenCalled();
  });

  it('says there is nowhere to write when the desktop is down and there is no key', async () => {
    const ctx = desktopCtx({ localApi: false });
    const err = await manageCollections.handler({ action: 'create', name: 'X' }, ctx).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/desktop app is not reachable/);
    expect((err as Error).message).not.toMatch(/cloud\/group/);
    expect(ctx.localWrites.writeCollections).not.toHaveBeenCalled();
  });

  it('keeps group libraries on the cloud, whatever the desktop holds', async () => {
    const ctx = desktopCtx({ cloud: true });
    ctx.capabilities.cloud.access = { groups: { all: { library: true, write: true } } };
    await manageCollections.handler({ action: 'create', name: 'X', library_type: 'group', library_id: 6666644 }, ctx);
    expect(ctx.localWrites.writeCollections).not.toHaveBeenCalled();
    expect(ctx.web.writeCollections).toHaveBeenCalledWith({ type: 'group', id: 6666644 }, [{ name: 'X', parentCollection: false }]);
  });
});

describe('the other personal-library writes go to the desktop too', () => {
  it('zotero_saved_searches creates and deletes', async () => {
    const ctx = desktopCtx();
    const conditions = [{ condition: 'tag', operator: 'is', value: 'thesis' }];
    const created = await savedSearches.handler({ action: 'create', name: 'thesis', conditions }, ctx);
    expect(ctx.localWrites.writeSearches).toHaveBeenCalledWith([{ name: 'thesis', conditions }]);
    expect(created.structuredContent).toMatchObject({ created: ['SRCH0001'], target: 'local' });
    await savedSearches.handler({ action: 'delete', search_key: 'SRCH0001' }, ctx);
    expect(ctx.localWrites.deleteSearches).toHaveBeenCalledWith(['SRCH0001']);
    expect(ctx.web.writeSearches).not.toHaveBeenCalled();
  });

  it('zotero_manage_tags adds and removes on the desktop copy', async () => {
    const ctx = desktopCtx();
    await manageTags.handler({ action: 'add', tags: ['new', 'old'], item_keys: ['AAAA1111'] }, ctx);
    expect(ctx.localWrites.patchItem).toHaveBeenLastCalledWith('AAAA1111', { tags: [{ tag: 'old' }, { tag: 'new' }] }, 2090);
    await manageTags.handler({ action: 'remove', tags: ['old'], item_keys: ['AAAA1111'] }, ctx);
    expect(ctx.localWrites.patchItem).toHaveBeenLastCalledWith('AAAA1111', { tags: [] }, 2090);
  });

  it('zotero_create_items validates, then writes to the desktop', async () => {
    const ctx = desktopCtx();
    const res = await createItems.handler({ items: [{ itemType: 'book', title: 'T' }] }, ctx);
    expect(ctx.schema.validateItem).toHaveBeenCalled();
    expect(ctx.localWrites.writeItems).toHaveBeenCalledWith([{ itemType: 'book', title: 'T' }]);
    expect(res.structuredContent).toMatchObject({ created: [{ key: 'ITEM0001', version: 50 }], target: 'local' });
  });

  it('zotero_create_items reports a batch Zotero refused in full as an error', async () => {
    const ctx = desktopCtx();
    ctx.localWrites.writeItems = vi.fn(async () => ({
      successful: [],
      unchanged: [],
      failed: [{ index: 0, code: 400, message: "Unknown itemType 'paper'" }],
      newLibraryVersion: 0,
    }));
    const res = await createItems.handler({ items: [{ itemType: 'book', title: 'T' }] }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Nothing succeeded: Unknown itemType/);
  });

  it('zotero_update_item patches at the desktop version and re-reads it from the desktop on a 412', async () => {
    const ctx = desktopCtx({ cloud: true });
    let n = 0;
    ctx.localWrites.patchItem = vi.fn(async () => {
      if (++n === 1) throw new ZoteroApiError({ status: 412, message: 'Local API PATCH /items/AAAA1111 failed (412)' });
      return 2093;
    });
    const res = await updateItem.handler({ item_key: 'AAAA1111', patch: { title: 'New' } }, ctx);
    expect(ctx.localWrites.patchItem).toHaveBeenNthCalledWith(1, 'AAAA1111', { title: 'New' }, 2090);
    expect(ctx.local.getItem).toHaveBeenCalledTimes(2);
    expect(ctx.web.getItem).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ newVersion: 2093, retried: true, target: 'local' });
  });

  it('zotero_update_item dry_run diffs against the copy the write would land in', async () => {
    const ctx = desktopCtx({ cloud: true });
    const res = await updateItem.handler({ item_key: 'AAAA1111', patch: { tags: [] }, dry_run: true }, ctx);
    expect(ctx.local.getItem).toHaveBeenCalled();
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ dryRun: true, version: 2090, target: 'local' });
  });

  it('zotero_fulltext action:"set" stores text on the desktop with no key', async () => {
    const ctx = desktopCtx();
    const res = await fulltext.handler(
      { action: 'set', item_key: 'PDFATT01', content: 'text', indexed_pages: 2, total_pages: 3 },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(ctx.localWrites.setFullText).toHaveBeenCalledWith(
      'PDFATT01',
      expect.objectContaining({ content: 'text', indexedPages: 2, totalPages: 3 }),
    );
    expect(ctx.web.setFullText).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ item_key: 'PDFATT01', length: 4, target: 'local' });
  });
});
