import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import attachment from '../../src/tools/attachment.js';
import { LocalApiError } from '../../src/api/local-client.js';

/**
 * zotero_attachment upload and download were cloud-only: every call went through
 * requireCloudLibrary, so a keyless install with Zotero 10.0.6 running could not store a
 * file it could have stored through the desktop's own upload endpoint, nor download a file
 * the desktop holds on its own disk. Both now go to the desktop app first, for any library
 * it holds, and to the cloud otherwise.
 */

const ME = { type: 'user', id: 0 };
const GROUP = { type: 'group', id: 6666644 };
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]);
const URL = 'https://arxiv.org/pdf/2501.12345v1';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zoteus-attachment-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const created = (key: string) => ({ successful: [{ index: 0, key, version: 9 }], unchanged: [], failed: [], newLibraryVersion: 9 });

function makeCtx(opts: { cloud?: boolean; localApi?: boolean; readsLocally?: boolean; groups?: number[] } = {}): any {
  const cloud = opts.cloud ?? false;
  return {
    config: { dataDir },
    remoteCaller: false,
    capabilities: {
      cloud: cloud ? { userID: 19552201, username: 'oscardvs', access: { user: { write: true }, groups: { all: { library: true, write: true } } } } : null,
      localApi: opts.localApi ?? true,
      localGroupIds: opts.groups ?? [],
    },
    router: {
      defaultLibrary: () => (cloud ? { type: 'user', id: 19552201 } : ME),
      readsLocally: vi.fn(async () => opts.readsLocally ?? opts.localApi ?? true),
      awaitingDesktopSync: vi.fn(async () => false),
    },
    fetcher: {
      fetch: vi.fn(async () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })),
    },
    local: {
      ping: vi.fn(async () => opts.localApi ?? true),
      downloadFileBytes: vi.fn(async () => PDF),
      getItem: vi.fn(async (key: string) => ({ key, version: 4, data: { key, itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf' } })),
    },
    localWrites: {
      writeItems: vi.fn(async () => created('LOCALATT')),
      uploadFile: vi.fn(async () => undefined),
    },
    web: {
      writeItems: vi.fn(async () => created('CLOUDATT')),
      requestUpload: vi.fn(async () => ({ url: 'https://s3.example/upload', contentType: 'multipart/form-data', prefix: 'P', suffix: 'S', uploadKey: 'UP1' })),
      uploadBytes: vi.fn(async () => undefined),
      registerUpload: vi.fn(async () => undefined),
      downloadFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([9, 9]), contentType: 'application/pdf' })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const text = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');

describe('zotero_attachment upload through the desktop app', () => {
  it('stores a url as a standalone attachment with no cloud key', async () => {
    const ctx = makeCtx();
    const res = await attachment.handler({ action: 'upload', url: URL, title: 'Preprint' }, ctx);
    expect(res.isError).toBeFalsy();
    const [[[item], lib]] = ctx.localWrites.writeItems.mock.calls;
    expect(lib).toEqual(ME);
    expect(item).toMatchObject({ itemType: 'attachment', linkMode: 'imported_file', title: 'Preprint', contentType: 'application/pdf', url: URL });
    // No parent_item: a standalone attachment, not one hung off an invented parent.
    expect(item.parentItem).toBeUndefined();
    expect(ctx.localWrites.uploadFile).toHaveBeenCalledWith(
      'LOCALATT',
      { bytes: PDF, filename: '2501.12345v1.pdf', contentType: 'application/pdf' },
      ME,
    );
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ key: 'LOCALATT', exists: false, bytes: PDF.length, target: 'local' });
    expect(text(res)).toMatch(/via the Zotero desktop app/);
  });

  it('stores a file from disk under a parent item', async () => {
    const ctx = makeCtx();
    const path = join(dataDir, 'notes.pdf');
    await writeFile(path, PDF);
    const res = await attachment.handler({ action: 'upload', file_path: path, parent_item: 'PARENT01' }, ctx);
    expect(ctx.localWrites.writeItems.mock.calls[0][0][0]).toMatchObject({ parentItem: 'PARENT01', title: 'notes.pdf' });
    expect(ctx.localWrites.uploadFile.mock.calls[0][1]).toMatchObject({ filename: 'notes.pdf', bytes: PDF });
    expect(res.structuredContent).toMatchObject({ target: 'local' });
  });

  it('stores into a group the desktop holds', async () => {
    const ctx = makeCtx({ groups: [6666644] });
    await attachment.handler({ action: 'upload', url: URL, library_type: 'group', library_id: 6666644 }, ctx);
    expect(ctx.localWrites.writeItems.mock.calls[0][1]).toEqual(GROUP);
    expect(ctx.localWrites.uploadFile.mock.calls[0][2]).toEqual(GROUP);
  });

  it('goes to the cloud for a group the desktop does not hold', async () => {
    const ctx = makeCtx({ cloud: true });
    const res = await attachment.handler({ action: 'upload', url: URL, library_type: 'group', library_id: 6666644 }, ctx);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).toHaveBeenCalledWith(GROUP, expect.any(Array));
    expect(res.structuredContent).toMatchObject({ key: 'CLOUDATT', target: 'cloud' });
  });

  it('falls back to the cloud when the running Zotero has no local-API writes, before anything was created', async () => {
    const ctx = makeCtx({ cloud: true });
    ctx.localWrites.writeItems = vi.fn(async () => {
      throw new Error('Local API local write failed (501): Endpoint does not support method');
    });
    const res = await attachment.handler({ action: 'upload', url: URL }, ctx);
    expect(ctx.web.uploadBytes).toHaveBeenCalledTimes(1);
    expect(res.structuredContent).toMatchObject({ key: 'CLOUDATT', target: 'cloud' });
  });

  it('does not retry on the cloud once the desktop attachment item exists', async () => {
    const ctx = makeCtx({ cloud: true });
    ctx.localWrites.uploadFile = vi.fn(async () => {
      throw new Error('Local API file-bytes upload failed (404): gone');
    });
    await expect(attachment.handler({ action: 'upload', url: URL }, ctx)).rejects.toThrow(/LOCALATT was created/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('refuses with no desktop app and no key, before fetching anything', async () => {
    const ctx = makeCtx({ localApi: false });
    await expect(attachment.handler({ action: 'upload', url: URL }, ctx)).rejects.toThrow(/nowhere to go/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('keeps the upload on the cloud while a cloud write to that library waits for the desktop to sync', async () => {
    const ctx = makeCtx({ cloud: true });
    ctx.router.awaitingDesktopSync = vi.fn(async () => true);
    const res = await attachment.handler({ action: 'upload', url: URL }, ctx);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ target: 'cloud' });
  });
});

describe('zotero_attachment download from the desktop app', () => {
  it("writes the desktop's own copy with no cloud key, typed from the attachment record", async () => {
    const ctx = makeCtx();
    const res = await attachment.handler({ action: 'download', item_key: 'PDFATT01' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.local.downloadFileBytes).toHaveBeenCalledWith('PDFATT01', ME);
    expect(ctx.web.downloadFileBytes).not.toHaveBeenCalled();
    const savePath = join(dataDir, 'attachments', 'PDFATT01');
    expect(new Uint8Array(await readFile(savePath))).toEqual(PDF);
    expect(res.structuredContent).toMatchObject({ savePath, bytes: PDF.length, contentType: 'application/pdf', readFrom: 'local' });
  });

  it('reads a group the desktop serves from the desktop', async () => {
    const ctx = makeCtx({ groups: [6666644] });
    await attachment.handler({ action: 'download', item_key: 'PDFATT01', library_type: 'group', library_id: 6666644 }, ctx);
    expect(ctx.router.readsLocally).toHaveBeenCalledWith(GROUP);
    expect(ctx.local.downloadFileBytes).toHaveBeenCalledWith('PDFATT01', GROUP);
  });

  it('falls back to Zotero file storage when the desktop cannot produce the file, and says why', async () => {
    const ctx = makeCtx({ cloud: true });
    ctx.local.downloadFileBytes = vi.fn(async () => {
      throw new LocalApiError(404, 'Local API file 404 for PDFATT01');
    });
    const res = await attachment.handler({ action: 'download', item_key: 'PDFATT01' }, ctx);
    expect(ctx.web.downloadFileBytes).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, 'PDFATT01');
    expect(res.structuredContent).toMatchObject({ bytes: 2, readFrom: 'cloud' });
    expect(text(res)).toMatch(/desktop app could not produce it \(Local API file 404 for PDFATT01\)/);
  });

  it('names the desktop failure when there is no key to fall back to', async () => {
    const ctx = makeCtx();
    ctx.local.downloadFileBytes = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory, open '/home/u/Zotero/storage/PDFATT01/paper.pdf'");
    });
    const res = await attachment.handler({ action: 'download', item_key: 'PDFATT01' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/could not produce the file of PDFATT01 \(ENOENT/);
    expect(text(res)).toMatch(/no cloud API key/);
  });

  it('reads the cloud directly while reads of the library are held there by an unsynced cloud write', async () => {
    const ctx = makeCtx({ cloud: true, readsLocally: false });
    const res = await attachment.handler({ action: 'download', item_key: 'PDFATT01' }, ctx);
    expect(ctx.local.downloadFileBytes).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ readFrom: 'cloud' });
    expect(text(res)).not.toMatch(/could not produce/);
  });

  it('says what a download needs when neither the desktop nor a key is there', async () => {
    const ctx = makeCtx({ localApi: false });
    const res = await attachment.handler({ action: 'download', item_key: 'PDFATT01' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/needs the Zotero desktop app running/);
    expect(text(res)).toMatch(/ZOTERO_API_KEY/);
  });
});
