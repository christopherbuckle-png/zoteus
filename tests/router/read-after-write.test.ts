import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { LocalApiError } from '../../src/api/local-client.js';
import { loadConfig } from '../../src/config.js';

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };
const personal = { type: 'user' as const, id: cloudInfo.userID };
const group = { type: 'group' as const, id: 6666644 };

/**
 * A router over a desktop app that holds the personal library and the test group, which is
 * the shape the bug needs: writes go to the cloud, reads would otherwise go to the desktop.
 *
 * `objectVersion` stands in for the one question this feature asks the desktop app, "what
 * version do you have for this key", answering null for an object it does not hold.
 */
function makeRouter(held: Record<string, number | null> = {}) {
  const web = {
    listItems: vi.fn(async () => ({ data: [{ key: 'CLOUD' }], totalResults: 1, lastModifiedVersion: 3476 })),
    getItem: vi.fn(async () => ({ key: 'CLOUD' })),
    listCollections: vi.fn(async () => ({ data: [{ key: 'CLOUDCOLL' }], totalResults: 1, lastModifiedVersion: 3476 })),
  };
  const local = {
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }], totalResults: 1, lastModifiedVersion: 681 })),
    getItem: vi.fn(async () => ({ key: 'LOCAL' })),
    listCollections: vi.fn(async () => ({ data: [{ key: 'LOCALCOLL' }], totalResults: 1, lastModifiedVersion: 681 })),
    objectVersion: vi.fn(async (_type: string, key: string) => held[key] ?? null),
  };
  const router = new LibraryRouter({
    config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
    capabilities: { cloud: cloudInfo, localApi: true, localGroupIds: [group.id] } as any,
    web: web as any,
    local: local as any,
  });
  return { router, web, local };
}

/** Let the baseline probe `noteCloudWrite` starts settle before asserting on it. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('reads after a cloud write', () => {
  it('keeps GROUP reads on the cloud until the desktop app has the new item', async () => {
    // Measured against the real Zotero Test group: the write returned key and version, the
    // next search returned nothing and get_item answered "Local API 404 for
    // /groups/6666644/items/<key>", so an agent verifying its own write is told it failed.
    const { router, web, local } = makeRouter();
    router.noteCloudWrite(group, 'items', ['SXD9FX9K']);
    await settle();

    expect((await router.searchItems({ q: 'x', library: group })).data[0].key).toBe('CLOUD');
    expect((await router.getItem('SXD9FX9K', { library: group })).key).toBe('CLOUD');
    expect(local.listItems).not.toHaveBeenCalled();
    expect(local.getItem).not.toHaveBeenCalled();
    expect(web.listItems).toHaveBeenCalled();
  });

  it('keeps PERSONAL reads on the cloud too, because those writes are cloud-only as well', async () => {
    // zotero_create_items and zotero_update_item call requireCloud for every library, so the
    // personal library has the identical bug: measured, create then get_item answered "Local
    // API 404 for /users/0/items/<key>".
    const { router, web, local } = makeRouter();
    router.noteCloudWrite(personal, 'items', ['7K99AMHD']);
    await settle();

    expect((await router.searchItems({ q: 'x' })).data[0].key).toBe('CLOUD');
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.listItems).toHaveBeenCalled();
  });

  it('files users/0 and users/<cloud id> as the one personal library', async () => {
    // The desktop calls it users/0 whatever its cloud id, so a write addressed one way has
    // to be found again by a read addressed the other.
    const { router, local } = makeRouter();
    router.noteCloudWrite({ type: 'user', id: cloudInfo.userID }, 'items', ['7K99AMHD']);
    await settle();

    expect((await router.searchItems({ library: { type: 'user', id: 0 } })).data[0].key).toBe('CLOUD');
    expect(local.listItems).not.toHaveBeenCalled();
  });

  it('covers every read of the library, not just items', async () => {
    const { router, local } = makeRouter();
    router.noteCloudWrite(personal, 'collections', ['COLL1234']);
    await settle();

    expect((await router.listCollections()).data[0].key).toBe('CLOUDCOLL');
    expect(local.listCollections).not.toHaveBeenCalled();
  });

  it('goes back to the desktop app once it holds the new item, and stops asking', async () => {
    const held: Record<string, number | null> = {};
    const { router, local } = makeRouter(held);
    router.noteCloudWrite(group, 'items', ['SXD9FX9K']);
    await settle();
    expect((await router.searchItems({ library: group })).data[0].key).toBe('CLOUD');

    // Zotero syncs: the desktop now has the item, under its OWN version.
    held.SXD9FX9K = 7;
    expect((await router.searchItems({ library: group })).data[0].key).toBe('LOCAL');

    const asked = local.objectVersion.mock.calls.length;
    expect((await router.searchItems({ library: group })).data[0].key).toBe('LOCAL');
    // The entry is gone, so later reads cost nothing extra.
    expect(local.objectVersion.mock.calls.length).toBe(asked);
  });

  it('holds an UPDATE on the cloud until the desktop version moves, not merely exists', async () => {
    // An update rewrites an item the desktop already has, so presence proves nothing: only
    // the desktop's own version for that key advancing past what it was shows the change
    // arrived. Comparing it with the cloud version would be meaningless, the two sequences
    // being unrelated (this library: cloud 3476, desktop 681).
    const held: Record<string, number | null> = { M9F48B3N: 623 };
    const { router, local } = makeRouter(held);
    router.noteCloudWrite(personal, 'items', ['M9F48B3N']);
    await settle();
    expect(local.objectVersion).toHaveBeenCalledWith('items', 'M9F48B3N', personal);

    expect((await router.searchItems({})).data[0].key).toBe('CLOUD');
    held.M9F48B3N = 687;
    expect((await router.searchItems({})).data[0].key).toBe('LOCAL');
  });

  it('watches a DELETE for the object disappearing instead', async () => {
    const held: Record<string, number | null> = { GONE1234: 41 };
    const { router } = makeRouter(held);
    router.noteCloudWrite(personal, 'items', ['GONE1234'], true);
    await settle();

    expect((await router.searchItems({})).data[0].key).toBe('CLOUD');
    delete held.GONE1234;
    expect((await router.searchItems({})).data[0].key).toBe('LOCAL');
  });

  it('leaves other libraries alone, and asks the desktop nothing about them', async () => {
    const { router, local } = makeRouter();
    router.noteCloudWrite(group, 'items', ['SXD9FX9K']);
    await settle();
    local.objectVersion.mockClear();

    expect((await router.searchItems({})).data[0].key).toBe('LOCAL');
    // The common case must not gain a round trip: no write, no question.
    expect(local.objectVersion).not.toHaveBeenCalled();
  });

  it('does not override a read pinned to one API for a whole crawl', async () => {
    // A pinned crawl records which API served it and stamps a version from that sequence;
    // splicing in cloud pages would stamp it with a version its rows never came from.
    const { router, local, web } = makeRouter();
    router.noteCloudWrite(personal, 'items', ['7K99AMHD']);
    await settle();

    expect((await router.searchItems({ backend: 'local' })).data[0].key).toBe('LOCAL');
    expect(local.listItems).toHaveBeenCalled();
    expect(web.listItems).not.toHaveBeenCalled();
  });

  it('still reports the standing routing rule, so a write does not invalidate the index', () => {
    const { router } = makeRouter();
    router.noteCloudWrite(personal, 'items', ['7K99AMHD']);
    expect(router.servesLocally()).toBe(true);
    expect(router.servesLocally(group)).toBe(true);
  });

  it('reads from the cloud when the desktop app cannot be asked at all', async () => {
    const { router, local, web } = makeRouter();
    local.objectVersion.mockRejectedValue(new LocalApiError(500, 'Local API 500 for /users/0/items/X'));
    router.noteCloudWrite(personal, 'items', ['7K99AMHD']);
    await settle();

    expect((await router.searchItems({})).data[0].key).toBe('CLOUD');
    expect(web.listItems).toHaveBeenCalled();
  });

  it('pins from the moment of the write, before the baseline has been measured', async () => {
    // The baseline probe is not awaited by the write, so the entry has to pin on its own:
    // a read landing in that window is exactly the read this bug is about.
    const { router, local } = makeRouter();
    let release: () => void = () => {};
    let calls = 0;
    local.objectVersion.mockImplementation(async () => {
      // The baseline is still in flight while the read below asks its own question.
      if (++calls === 1) return new Promise<number | null>((r) => (release = () => r(null)));
      return null;
    });
    router.noteCloudWrite(group, 'items', ['SXD9FX9K']);

    expect((await router.searchItems({ library: group })).data[0].key).toBe('CLOUD');
    release();
  });

  it('ignores a write with no keys, which is a write that wrote nothing', async () => {
    const { router, local } = makeRouter();
    router.noteCloudWrite(personal, 'items', []);
    await settle();

    expect((await router.searchItems({})).data[0].key).toBe('LOCAL');
    expect(local.objectVersion).not.toHaveBeenCalled();
  });
});

/**
 * Writes now go to the desktop for every library it holds, groups included. A library whose
 * reads are held on the cloud by an unsynced cloud write keeps its writes there as well, so
 * the write tools ask the router before choosing the desktop.
 */
describe('awaitingDesktopSync, the write side of the same rule', () => {
  it('is false for a library nobody wrote to on the cloud, and asks the desktop nothing', async () => {
    const { router, local } = makeRouter();
    expect(await router.awaitingDesktopSync(group)).toBe(false);
    expect(await router.awaitingDesktopSync({ type: 'user', id: 0 })).toBe(false);
    expect(local.objectVersion).not.toHaveBeenCalled();
  });

  it('holds a group while its cloud write is unsynced, and releases it (for reads too) once the desktop has it', async () => {
    const held: Record<string, number | null> = {};
    const { router, local } = makeRouter(held);
    router.noteCloudWrite(group, 'items', ['NEWITEM1']);
    await settle();
    expect(await router.awaitingDesktopSync(group)).toBe(true);

    held.NEWITEM1 = 12;
    expect(await router.awaitingDesktopSync(group)).toBe(false);
    // The entry is retired, so the next read goes to the desktop without asking again.
    local.objectVersion.mockClear();
    expect((await router.getItem('NEWITEM1', { library: group })).key).toBe('LOCAL');
    expect(local.objectVersion).not.toHaveBeenCalled();
  });

  it('never holds a library the desktop does not serve: there is no desktop write to keep away from it', async () => {
    const { router } = makeRouter();
    const elsewhere = { type: 'group' as const, id: 999 };
    router.noteCloudWrite(elsewhere, 'items', ['K']);
    await settle();
    expect(await router.awaitingDesktopSync(elsewhere)).toBe(false);
  });
});
