import { describe, it, expect, vi } from 'vitest';
import fulltext from '../../src/tools/fulltext.js';

/**
 * A key-free context: the desktop app is up, there is no cloud identity. `capabilities.cloud`
 * is what every write gate reads.
 */
function keyFreeCtx(defaultLibrary: { type: 'user' | 'group'; id: number } = { type: 'user', id: 0 }) {
  const setFullText = vi.fn(async () => undefined);
  return {
    ctx: {
      config: { libraryType: 'user', libraryId: undefined },
      capabilities: { cloud: null, localApi: true, localGroupIds: [6666644] },
      router: { defaultLibrary: () => defaultLibrary },
      web: { setFullText },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as any,
    setFullText,
  };
}

describe('zotero_fulltext action:"set" refuses in terms of the operation, not the library', () => {
  it('goes to the desktop app for the personal library, and names its refusal when it has no endpoint', async () => {
    // This used to be refused outright as cloud-only, on the grounds that neither desktop
    // write path had a full-text endpoint (#79). Zotero 10's local API has one, PUT
    // .../items/<key>/fulltext (measured on 10.0.6), so the write now goes there. A desktop
    // without it answers 501, and with no key to fall back to, the refusal says the desktop
    // refused, not that the library is "cloud/group".
    const { ctx, setFullText } = keyFreeCtx();
    ctx.localWrites = {
      setFullText: vi.fn(async () => {
        throw new Error('Local API PUT /items/CKSETW3U/fulltext failed (501): Endpoint does not support method');
      }),
    };
    const res = await fulltext.handler({ action: 'set', item_key: 'CKSETW3U', content: 'text' }, ctx).catch(
      (e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }),
    );
    expect(res.isError).toBe(true);
    const msg = res.content[0]!.text;
    expect(msg).toMatch(/did not accept this write/);
    expect(msg).toMatch(/ZOTERO_API_KEY/);
    expect(msg).not.toMatch(/cloud\/group/);
    expect(ctx.localWrites.setFullText).toHaveBeenCalledWith('CKSETW3U', expect.objectContaining({ content: 'text' }), expect.objectContaining({ type: 'user' }));
    expect(setFullText).not.toHaveBeenCalled();
  });

  it('leaves the group refusal to the shared cloud gate, which is already accurate', async () => {
    const { ctx, setFullText } = keyFreeCtx();
    const res = await fulltext.handler(
      { action: 'set', item_key: 'CKSETW3U', content: 'text', library_type: 'group', library_id: 6666644 },
      ctx,
    ).catch((e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/group library 6666644/);
    expect(setFullText).not.toHaveBeenCalled();
  });

  it('still requires item_key and content before anything else', async () => {
    const { ctx } = keyFreeCtx();
    const res = await fulltext.handler({ action: 'set', item_key: 'CKSETW3U' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/`item_key` and `content` are required/);
  });

  it('writes through the Web API when a cloud key can take it', async () => {
    const { ctx, setFullText } = keyFreeCtx();
    ctx.capabilities.cloud = { userID: 19552201, access: { user: { write: true } } };
    const res = await fulltext.handler(
      { action: 'set', item_key: 'CKSETW3U', content: 'text', indexed_pages: 2, total_pages: 3 },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(setFullText).toHaveBeenCalledWith(
      { type: 'user', id: 0 },
      'CKSETW3U',
      expect.objectContaining({ content: 'text', indexedPages: 2, totalPages: 3 }),
    );
  });
});
