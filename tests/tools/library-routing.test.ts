import { describe, it, expect, vi } from 'vitest';
import createItems from '../../src/tools/create-items.js';
import annotate from '../../src/tools/annotate.js';
import trashItems from '../../src/tools/trash-items.js';
import deleteItems from '../../src/tools/delete-items.js';
import { requireCloudLibrary } from '../../src/registry/registry.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import { ZoteroApiError } from '../../src/api/errors.js';
import type { LibraryRef } from '../../src/api/web-client.js';

/**
 * Issue #61. With ZOTERO_LIBRARY_TYPE=group and ZOTERO_LIBRARY_ID set, a write with no
 * per-call library went to the key's personal library, and an annotation that named a group
 * still looked its parent up in the personal library. These tests drive the real handlers
 * and the real LibraryRouter (built from the same environment variables) against a fake Web
 * API that holds each item in exactly one library and answers 404 for any other, so a
 * lookup in the wrong library fails the way api.zotero.org would, before any write.
 */

const KEY_USER_ID = 123;
const GROUP_ID = 456;
const USER: LibraryRef = { type: 'user', id: KEY_USER_ID };
const GROUP: LibraryRef = { type: 'group', id: GROUP_ID };

/** One item and the single library it lives in; `children` are its child attachments. */
interface Holding {
  library: LibraryRef;
  data: Record<string, unknown>;
  children?: Array<Record<string, unknown>>;
}

const PDF = { itemType: 'attachment', contentType: 'application/pdf', linkMode: 'imported_file' };

function makeCtx(
  opts: {
    /** `group` configures group 456 as the default; otherwise the key's personal library is. */
    defaultLibrary?: 'user' | 'group';
    /** Whether a cloud key (user 123) is configured. Default true. */
    cloud?: boolean;
    /** Whether the desktop app is up, with both local-API and connector writes. Default false. */
    desktop?: boolean;
    allowDelete?: boolean;
    holdings?: Record<string, Holding>;
  } = {},
) {
  const cloud = opts.cloud ?? true;
  const holdings = opts.holdings ?? {};
  const sameLib = (a: LibraryRef, b: LibraryRef) => a.type === b.type && a.id === b.id;
  const find = (lib: LibraryRef, key: string): Holding => {
    const h = holdings[key];
    if (!h || !sameLib(h.library, lib)) {
      throw new ZoteroApiError({
        status: 404,
        message: `Not found: ${lib.type}s/${lib.id}/items/${key}`,
      });
    }
    return h;
  };
  const web = {
    hasKey: cloud,
    getItem: vi.fn(async (lib: LibraryRef, key: string) => {
      const h = find(lib, key);
      return { key, version: 3, data: { key, version: 3, ...h.data } };
    }),
    getItemChildren: vi.fn(async (lib: LibraryRef, key: string) => {
      const data = (find(lib, key).children ?? []).map((c) => ({ key: c.key, data: c }));
      return { data, totalResults: data.length, lastModifiedVersion: 3 };
    }),
    writeItems: vi.fn(async (_lib: LibraryRef, items: unknown[]) => ({
      successful: items.map((_, i) => ({ index: i, key: `NEW${i}`, version: 4 })),
      unchanged: [],
      failed: [],
      newLibraryVersion: 4,
    })),
    currentLibraryVersion: vi.fn(async () => 100),
    deleteItems: vi.fn(async () => undefined),
  };
  const env: Record<string, string> = { ZOTEUS_LOCAL: 'auto' };
  if (opts.defaultLibrary === 'group') {
    env.ZOTERO_LIBRARY_TYPE = 'group';
    env.ZOTERO_LIBRARY_ID = String(GROUP_ID);
  }
  const config = { ...loadConfig(env as any), allowDelete: opts.allowDelete ?? false };
  const capabilities = {
    cloud: cloud ? { userID: KEY_USER_ID, username: 'probe', access: {} } : null,
    localApi: Boolean(opts.desktop),
    localGroupIds: [],
  };
  // No `local` read client: every router read goes to the fake Web API, whose 404 is the
  // wrong-library signal these tests look for.
  const router = new LibraryRouter({ config, capabilities: capabilities as any, web: web as any });
  const localWrites = {
    writeItems: vi.fn(async (items: unknown[]) => ({
      successful: items.map((_, i) => ({ index: i, key: `LOCAL${i}`, version: 9 })),
      unchanged: [],
      failed: [],
      newLibraryVersion: 9,
    })),
    setDeleted: vi.fn(async (keys: string[]) => ({
      successful: keys.map((key, i) => ({ index: i, key, version: 9 })),
      unchanged: [] as string[],
      // Typed rather than inferred: an empty literal infers never[], which stops a test
      // overriding this mock with a run that actually fails.
      failed: [] as { index: number; code: number; message: string; key: string }[],
      newLibraryVersion: 9,
    })),
    deleteItems: vi.fn(async () => undefined),
  };
  const connectorWrites = {
    saveItems: vi.fn(async () => ({ sessionID: 'S1', connectorIds: ['c1'] })),
  };
  const ctx: any = {
    config,
    capabilities,
    router,
    web,
    schema: { validateItem: vi.fn(async () => ({ valid: true, errors: [] })) },
    localWrites: opts.desktop ? localWrites : undefined,
    connectorWrites: opts.desktop ? connectorWrites : undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  return { ctx, web, localWrites, connectorWrites };
}

type Web = ReturnType<typeof makeCtx>['web'];
/** The libraries `writeItems` was asked to write to, in call order. */
const writtenTo = (web: Web) => web.writeItems.mock.calls.map((c) => c[0]);
/** `[library, key]` of every item and children read, in call order. */
const readFrom = (web: Web) =>
  [...web.getItem.mock.calls, ...web.getItemChildren.mock.calls].map((c) => [c[0], c[1]]);

const probeNote = { type: 'note', comment: 'Routing probe', page: 0 };

describe('requireCloudLibrary (#61)', () => {
  it('follows the configured group default when the call names no library', () => {
    const { ctx } = makeCtx({ defaultLibrary: 'group' });
    expect(ctx.router.defaultLibrary()).toEqual(GROUP);
    expect(requireCloudLibrary(ctx, {})).toEqual(GROUP);
  });

  it('lets an explicit per-call library override the configured default', () => {
    const { ctx: groupDefault } = makeCtx({ defaultLibrary: 'group' });
    expect(
      requireCloudLibrary(groupDefault, { library_type: 'user', library_id: KEY_USER_ID }),
    ).toEqual(USER);
    const { ctx: personalDefault } = makeCtx();
    expect(
      requireCloudLibrary(personalDefault, { library_type: 'group', library_id: GROUP_ID }),
    ).toEqual(GROUP);
  });

  it("falls back to the key's personal library when nothing is configured", () => {
    const { ctx } = makeCtx();
    expect(requireCloudLibrary(ctx, {})).toEqual(USER);
  });

  it('refuses a group target with no cloud key rather than picking the personal library', () => {
    const { ctx } = makeCtx({ defaultLibrary: 'group', cloud: false });
    expect(() => requireCloudLibrary(ctx, {})).toThrow(/cloud API key/);
    expect(() => requireCloudLibrary(ctx, { library_type: 'group', library_id: GROUP_ID })).toThrow(
      /cloud API key/,
    );
  });
});

describe('zotero_create_items routing (#61)', () => {
  const book = { items: [{ itemType: 'book', title: 'Routing probe' }] };

  it('writes only to the configured group when the call names no library', async () => {
    const { ctx, web } = makeCtx({ defaultLibrary: 'group' });
    const res = await createItems.handler(book, ctx);
    expect(res.isError).toBeFalsy();
    expect(writtenTo(web)).toEqual([GROUP]);
  });

  it('writes to an explicit personal library over a group default', async () => {
    const { ctx, web } = makeCtx({ defaultLibrary: 'group' });
    await createItems.handler({ ...book, library_type: 'user', library_id: KEY_USER_ID }, ctx);
    expect(writtenTo(web)).toEqual([USER]);
  });

  it('writes to an explicit group over a personal default', async () => {
    const { ctx, web } = makeCtx();
    await createItems.handler({ ...book, library_type: 'group', library_id: GROUP_ID }, ctx);
    expect(writtenTo(web)).toEqual([GROUP]);
  });

  it('fails before writing when no cloud key can reach the configured group', async () => {
    const { ctx, web } = makeCtx({ defaultLibrary: 'group', cloud: false });
    await expect(createItems.handler(book, ctx)).rejects.toThrow(/cloud API key/);
    expect(web.writeItems).not.toHaveBeenCalled();
  });
});

describe('zotero_annotate resolves the parent in the selected library (#61)', () => {
  /** Everything here exists only in group 456: a bare PDF, a regular item with one PDF child, an annotation. */
  const groupOnly: Record<string, Holding> = {
    PDFGROUP: { library: GROUP, data: { ...PDF } },
    ITEMGROUP: {
      library: GROUP,
      data: { itemType: 'journalArticle' },
      children: [{ key: 'PDFCHILD', ...PDF }],
    },
    ANNGROUP: { library: GROUP, data: { itemType: 'annotation', parentItem: 'PDFGROUP' } },
  };

  it('reads a direct attachment key from an explicit group, then writes there', async () => {
    const { ctx, web } = makeCtx({ holdings: groupOnly });
    const res = await annotate.handler(
      { parent: 'PDFGROUP', library_type: 'group', library_id: GROUP_ID, annotations: [probeNote] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(readFrom(web)).toEqual([[GROUP, 'PDFGROUP']]);
    expect(writtenTo(web)).toEqual([GROUP]);
    expect(web.writeItems.mock.calls[0]![1][0]).toMatchObject({
      itemType: 'annotation',
      parentItem: 'PDFGROUP',
      annotationType: 'note',
    });
  });

  it('reads a regular-item parent and its children from the explicit group', async () => {
    const { ctx, web } = makeCtx({ holdings: groupOnly });
    const res = await annotate.handler(
      {
        parent: 'ITEMGROUP',
        library_type: 'group',
        library_id: GROUP_ID,
        annotations: [probeNote],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(readFrom(web)).toEqual([
      [GROUP, 'ITEMGROUP'],
      [GROUP, 'ITEMGROUP'],
    ]);
    expect(writtenTo(web)).toEqual([GROUP]);
    expect(web.writeItems.mock.calls[0]![1][0]).toMatchObject({ parentItem: 'PDFCHILD' });
  });

  it('applies a configured group default to the parent read and the write alike', async () => {
    const { ctx, web } = makeCtx({ defaultLibrary: 'group', holdings: groupOnly });
    const res = await annotate.handler({ parent: 'ITEMGROUP', annotations: [probeNote] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(readFrom(web)).toEqual([
      [GROUP, 'ITEMGROUP'],
      [GROUP, 'ITEMGROUP'],
    ]);
    expect(writtenTo(web)).toEqual([GROUP]);
  });

  it('never lets a running desktop app pull a group annotation into the personal library', async () => {
    const { ctx, web, localWrites, connectorWrites } = makeCtx({
      defaultLibrary: 'group',
      desktop: true,
      holdings: groupOnly,
    });
    const res = await annotate.handler({ parent: 'PDFGROUP', annotations: [probeNote] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(localWrites.writeItems).not.toHaveBeenCalled();
    expect(connectorWrites.saveItems).not.toHaveBeenCalled();
    expect(writtenTo(web)).toEqual([GROUP]);
    expect(res.structuredContent?.target).toBe('cloud');
  });

  it('trashes annotations in the configured group rather than through the desktop app', async () => {
    const { ctx, web, localWrites } = makeCtx({
      defaultLibrary: 'group',
      desktop: true,
      holdings: groupOnly,
    });
    const res = await annotate.handler({ action: 'delete', annotation_keys: ['ANNGROUP'] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(localWrites.setDeleted).not.toHaveBeenCalled();
    expect(web.writeItems).toHaveBeenCalledWith(GROUP, [
      { key: 'ANNGROUP', version: 3, deleted: 1 },
    ]);
  });

  it('still hands a personal-library annotation to the desktop app', async () => {
    const { ctx, web, localWrites } = makeCtx({
      desktop: true,
      holdings: { PDFUSER: { library: USER, data: { ...PDF } } },
    });
    const res = await annotate.handler({ parent: 'PDFUSER', annotations: [probeNote] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(localWrites.writeItems).toHaveBeenCalledTimes(1);
    expect(web.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent?.target).toBe('local');
  });
});

describe('zotero_trash_items and zotero_delete_items follow the resolved library (#61)', () => {
  const inGroup: Record<string, Holding> = { K1: { library: GROUP, data: { itemType: 'book' } } };

  it('trash with a group default skips the desktop app and writes the group', async () => {
    const { ctx, web, localWrites } = makeCtx({
      defaultLibrary: 'group',
      desktop: true,
      holdings: inGroup,
    });
    await trashItems.handler({ item_keys: ['K1'] }, ctx);
    expect(localWrites.setDeleted).not.toHaveBeenCalled();
    expect(web.writeItems).toHaveBeenCalledWith(GROUP, [{ key: 'K1', version: 3, deleted: 1 }]);
  });

  it('trash with an explicit personal library over a group default takes the desktop path', async () => {
    const { ctx, web, localWrites } = makeCtx({ defaultLibrary: 'group', desktop: true });
    await trashItems.handler(
      { item_keys: ['K1'], library_type: 'user', library_id: KEY_USER_ID },
      ctx,
    );
    expect(localWrites.setDeleted).toHaveBeenCalledWith(['K1'], 1, { type: 'user', id: KEY_USER_ID });
    expect(web.writeItems).not.toHaveBeenCalled();
  });

  // The desktop branch built `updated` from the per-item outcomes and returned it as
  // success, so a key Zotero refused came back as "Trashed 0 item(s)" with no error flag and
  // the 400 only in `failed`. An agent trashing its own test data read that as done.
  it('reports a desktop trash where every key failed as an error', async () => {
    const { ctx, localWrites } = makeCtx({ desktop: true });
    localWrites.setDeleted.mockImplementationOnce(async () => ({
      successful: [],
      unchanged: [],
      failed: [{ index: 0, code: 400, message: 'itemType property not provided', key: 'ZZZZZZZZ' }],
      newLibraryVersion: 9,
    }));
    const res = await trashItems.handler({ item_keys: ['ZZZZZZZZ'] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Nothing succeeded');
    expect(res.content[0].text).toContain('itemType property not provided');
    expect((res.structuredContent as any).updated).toEqual([]);
  });

  it('keeps a partial desktop trash a success and names the failure count', async () => {
    const { ctx, localWrites } = makeCtx({ desktop: true });
    localWrites.setDeleted.mockImplementationOnce(async () => ({
      successful: [{ index: 0, key: 'K1', version: 9 }],
      unchanged: [],
      failed: [{ index: 1, code: 400, message: 'nope', key: 'ZZZZZZZZ' }],
      newLibraryVersion: 9,
    }));
    const res = await trashItems.handler({ item_keys: ['K1', 'ZZZZZZZZ'] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('1 failed.');
  });

  it('delete with a group default skips the desktop app and deletes in the group', async () => {
    const { ctx, web, localWrites } = makeCtx({
      defaultLibrary: 'group',
      desktop: true,
      allowDelete: true,
    });
    await deleteItems.handler({ item_keys: ['K1'], confirm: true }, ctx);
    expect(localWrites.deleteItems).not.toHaveBeenCalled();
    expect(web.deleteItems).toHaveBeenCalledWith(GROUP, ['K1'], 100);
  });

  it('a group default with no cloud key fails instead of trashing through the desktop app', async () => {
    const { ctx, web, localWrites } = makeCtx({
      defaultLibrary: 'group',
      desktop: true,
      cloud: false,
    });
    await expect(trashItems.handler({ item_keys: ['K1'] }, ctx)).rejects.toThrow(/cloud API key/);
    expect(localWrites.setDeleted).not.toHaveBeenCalled();
    expect(web.writeItems).not.toHaveBeenCalled();
  });
});
