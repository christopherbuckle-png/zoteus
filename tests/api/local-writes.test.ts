import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWriteClient } from '../../src/api/local-writes.js';
import { RateLimitedFetcher, type FetchLike } from '../../src/api/http.js';
import { isLocalWritesUnavailable } from '../../src/registry/registry.js';

const SERVER_ID = 'zotero-instance-1';

/** A local API that answers GETs with a Zotero-Server-ID and records writes. */
function makeClient(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  opts: { key?: string; keyStorePath?: string } = {},
) {
  // FetchLike's `init` is optional and the fixtures' is not, which under strictFunctionTypes
  // is a real variance mismatch and never a real one at run time: the fetcher always passes it.
  const fetcher = new RateLimitedFetcher({ fetchImpl: fetchImpl as FetchLike, maxConcurrency: 2 });
  return new LocalWriteClient({
    port: 23119,
    fetcher,
    key: opts.key,
    keyStorePath: opts.keyStorePath,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
  });
}

function okJson(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/** The probe GET carries both preconditions a Zotero 10 write needs. */
function probeResponse(serverId = SERVER_ID, libraryVersion = '17'): Response {
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'zotero-server-id': serverId, 'last-modified-version': libraryVersion },
  });
}

describe('LocalWriteClient (Zotero 10+ desktop writes)', () => {
  it('writes items with a pre-provisioned key and the required server-id header', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      return okJson({ successful: { '0': { key: 'NEWKEY1', version: 42 } }, failed: {}, unchanged: {} }, { 'last-modified-version': '42' });
    });
    const client = makeClient(fetchImpl, { key: 'preset-key' });
    const result = await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(result.successful).toEqual([{ index: 0, key: 'NEWKEY1', version: 42 }]);
    expect(result.failed).toEqual([]);
    expect(result.newLibraryVersion).toBe(42);
    // No authorize round-trip when a key is pre-provisioned.
    expect(seen.some((s) => s.url.includes('/local/authorize'))).toBe(false);
    // The server id and library version come on every local API response, so the probe
    // that reads them is the cheap collections listing, not an items listing whose cost is
    // the size of the library (#102).
    expect(seen[0]!.url).toBe('http://127.0.0.1:23119/api/users/0/collections?limit=1');
    const write = seen.find((s) => s.url.endsWith('/users/0/items') && s.headers['Content-Type'] === 'application/json');
    expect(write).toBeTruthy();
    expect(write!.headers['Zotero-API-Key']).toBe('preset-key');
    expect(write!.headers['Zotero-Server-ID']).toBe(SERVER_ID);
    // A pure create needs no concurrency precondition — only key-based writes do.
    expect(write!.headers['If-Unmodified-Since-Version']).toBeUndefined();
  });

  it('sends the library-version precondition on key-based writes', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return okJson({ successful: { '0': { key: 'K1', version: 18 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.writeItems([{ key: 'K1', title: 'Renamed' }]);
    expect(seen[0]!['If-Unmodified-Since-Version']).toBe('17');
  });

  it('authorizes via the grant dialog when no key exists, and caches the grant on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-grant-'));
    const keyStorePath = join(dir, 'local-api-key.json');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) {
        const body = JSON.parse(String(init.body));
        expect(body.appName).toBeTruthy();
        // POST /api/local/authorize is itself a write method, so Zotero 10 rejects it
        // with 428 unless the caller echoes the server ID it learned from a read.
        expect((init.headers as any)['Zotero-Server-ID']).toBe(SERVER_ID);
        return okJson({ key: 'granted-key', remember: true });
      }
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      return okJson({ successful: { '0': { key: 'K1', version: 1 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl, { keyStorePath });
    const result = await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(result.successful[0]?.key).toBe('K1');
    // The grant was persisted so future runs skip the dialog.
    expect(existsSync(keyStorePath)).toBe(true);
    const grant = JSON.parse(readFileSync(keyStorePath, 'utf8'));
    expect(grant.key).toBe('granted-key');
    expect(grant.remember).toBe(true);
  });

  it('loads a cached grant from disk instead of prompting again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-grant-'));
    const keyStorePath = join(dir, 'local-api-key.json');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) throw new Error('authorize should not be called');
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      expect((init.headers as any)['Zotero-API-Key']).toBe('cached-key');
      return okJson({ successful: {}, failed: {}, unchanged: {} });
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(keyStorePath, JSON.stringify({ key: 'cached-key', appName: 'Zoteus MCP', grantedAt: 'now' }));
    const client = makeClient(fetchImpl, { keyStorePath });
    await client.writeItems([]);
  });

  it('re-authorizes once on 401 (single-use "Allow" grant consumed)', async () => {
    let writes = 0;
    let authorizations = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) {
        authorizations++;
        return okJson({ key: `key-${authorizations}`, remember: false });
      }
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      writes++;
      if (writes === 1) return new Response('key consumed', { status: 401 });
      expect((init.headers as any)['Zotero-API-Key']).toBe('key-2');
      return okJson({ successful: { '0': { key: 'K9', version: 2 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl);
    const result = await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(authorizations).toBe(2);
    expect(writes).toBe(2);
    expect(result.successful[0]?.key).toBe('K9');
  });

  it('re-probes the server id and library version on 428/412', async () => {
    let serverId = 'old-instance';
    let libraryVersion = '5';
    let writes = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse(serverId, libraryVersion);
      writes++;
      if (writes === 1) {
        expect((init.headers as any)['Zotero-Server-ID']).toBe('old-instance');
        expect((init.headers as any)['If-Unmodified-Since-Version']).toBe('5');
        serverId = 'new-instance'; // Zotero restarted: the old id is now stale
        libraryVersion = '6'; // ...and the library moved on
        return new Response('precondition failed', { status: 412 });
      }
      expect((init.headers as any)['Zotero-Server-ID']).toBe('new-instance');
      expect((init.headers as any)['If-Unmodified-Since-Version']).toBe('6');
      return okJson({ successful: {}, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.writeItems([{ key: 'K1', title: 'T' }]);
    expect(writes).toBe(2);
  });

  it('surfaces a human-readable error when the user denies the grant dialog', async () => {
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith('/local/authorize')) return new Response('denied', { status: 403 });
      return probeResponse();
    });
    const client = makeClient(fetchImpl);
    await expect(client.writeItems([{ itemType: 'book' }])).rejects.toThrow(/denied/i);
  });

  it('re-probes once when authorize is rejected for a stale server id (412)', async () => {
    let serverId = 'old-instance';
    let attempts = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) {
        attempts++;
        if (attempts === 1) {
          serverId = 'new-instance';
          return new Response('Zotero-Server-ID does not match this server', { status: 412 });
        }
        expect((init.headers as any)['Zotero-Server-ID']).toBe('new-instance');
        return okJson({ key: 'granted', remember: true });
      }
      if ((init?.method ?? 'GET') === 'GET') return probeResponse(serverId);
      return okJson({ successful: { '0': { key: 'K1', version: 1 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl);
    await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(attempts).toBe(2);
  });

  it('trashes by writing deleted:1 — never by DELETE, which erases outright', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init.body ? String(init.body) : undefined });
      if (method === 'GET') return probeResponse();
      return okJson(
        { successful: { '0': { key: 'K1', version: 9 } }, failed: {}, unchanged: { '1': 'K2' } },
        { 'last-modified-version': '9' },
      );
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    const result = await client.setDeleted(['K1', 'K2'], 1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const post = calls.find((c) => c.method === 'POST');
    expect(post!.url).toMatch(/\/users\/0\/items$/);
    expect(JSON.parse(post!.body!)).toEqual([
      { key: 'K1', deleted: 1 },
      { key: 'K2', deleted: 1 },
    ]);
    expect(result.successful.map((s) => s.key)).toEqual(['K1']);
    // `unchanged` is index-keyed on the wire; it comes back resolved to item keys.
    expect(result.unchanged).toEqual(['K2']);
  });

  it('permanently deletes via ?itemKey= with the version precondition (no /deleted path)', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
      if (method === 'GET') return probeResponse();
      return new Response(null, { status: 204, headers: { 'last-modified-version': '18' } });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.deleteItems(['K1', 'K2']);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('/users/0/items?itemKey=K1,K2');
    expect(del.url).not.toContain('/deleted');
    expect(del.headers['If-Unmodified-Since-Version']).toBe('17');
    expect(del.headers['Zotero-Server-ID']).toBe(SERVER_ID);
  });

  it('chunks deletes at the local API batch limit of 50', async () => {
    const deletes: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      deletes.push(url);
      return new Response(null, { status: 204 });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.deleteItems(Array.from({ length: 120 }, (_, i) => `K${i}`));
    expect(deletes).toHaveLength(3);
    expect(deletes[0]!.split(',')).toHaveLength(50);
    expect(deletes[2]!.split(',')).toHaveLength(20);
  });

  it('stores a file in three phases: authorize, POST the bytes, register the uploadKey', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const bytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return probeResponse();
      calls.push({ url, method, body: typeof init.body === 'string' ? init.body : '<bytes>' });
      if (url.endsWith('/items/ATT1/file')) {
        const form = new URLSearchParams(String(init.body));
        return form.get('upload')
          ? new Response(null, { status: 204 })
          : okJson({ url: 'http://127.0.0.1:23119/storage/upload', uploadKey: 'up-1' });
      }
      return new Response(null, { status: 200 });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.uploadFile('ATT1', { bytes, filename: 'paper.pdf', contentType: 'application/pdf', mtimeMs: 1700000000000 });
    expect(calls).toHaveLength(3);
    const authorize = new URLSearchParams(calls[0]!.body!);
    expect(calls[0]!.url).toMatch(/\/users\/0\/items\/ATT1\/file$/);
    expect(authorize.get('filename')).toBe('paper.pdf');
    expect(authorize.get('filesize')).toBe('4');
    expect(authorize.get('contentType')).toBe('application/pdf');
    expect(authorize.get('md5')).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[1]!.url).toBe('http://127.0.0.1:23119/storage/upload');
    expect(calls[1]!.body).toBe('<bytes>');
    expect(new URLSearchParams(calls[2]!.body!).get('upload')).toBe('up-1');
  });

  it('skips the byte upload when Zotero already stores an identical file', async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      posts.push(url);
      return okJson({ exists: 1 });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.uploadFile('ATT1', { bytes: new Uint8Array([1]), filename: 'a.pdf', contentType: 'application/pdf' });
    expect(posts).toEqual([expect.stringMatching(/\/items\/ATT1\/file$/)]);
  });

  // Collections, saved searches and full text: the writes Zotero 10's local API takes that
  // Zoteus used to send to the cloud only (measured against Zotero 10.0.6).
  it('creates collections at /collections with no precondition, and renames by key and version without the library one', async () => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      posts.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init.body)) });
      return okJson({ successful: { '0': { key: 'SUBCOL01', version: 18 } }, failed: {}, unchanged: {} }, { 'last-modified-version': '18' });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    const created = await client.writeCollections([{ name: 'Draft', parentCollection: 'THESIS01' }]);
    expect(created.successful).toEqual([{ index: 0, key: 'SUBCOL01', version: 18 }]);
    expect(posts[0]!.url).toBe('http://127.0.0.1:23119/api/users/0/collections');
    expect(posts[0]!.headers['If-Unmodified-Since-Version']).toBeUndefined();
    // A per-object version is the precondition; the library one would add only a 412
    // whenever anything else in the library moved since the last probe.
    await client.writeCollections([{ key: 'SUBCOL01', version: 18, name: 'Final' }]);
    expect(posts[1]!.headers['If-Unmodified-Since-Version']).toBeUndefined();
    // A keyed write without a version still needs one, and gets the library's.
    await client.writeCollections([{ key: 'SUBCOL01', name: 'Final' }]);
    expect(posts[2]!.headers['If-Unmodified-Since-Version']).toBe('18');
  });

  it('writes saved searches at /searches', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      urls.push(url);
      return okJson({ successful: { '0': { key: 'SRCH0001', version: 18 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.writeSearches([{ name: 's', conditions: [{ condition: 'tag', operator: 'is', value: 'x' }] }]);
    expect(urls).toEqual(['http://127.0.0.1:23119/api/users/0/searches']);
  });

  it('splits a write of more than 50 objects into batches and keeps the caller\'s indexes', async () => {
    // The local API answers a batch of 51 with 413; create_items promises auto-chunking.
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      const batch = JSON.parse(String(init.body)) as unknown[];
      sizes.push(batch.length);
      const failed = sizes.length === 2 ? { '3': { code: 400, message: 'bad' } } : {};
      return okJson({ successful: { '0': { key: `K${sizes.length}`, version: 1 } }, failed, unchanged: { '1': 'U' } });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    const result = await client.writeItems(Array.from({ length: 120 }, () => ({ itemType: 'book' })));
    expect(sizes).toEqual([50, 50, 20]);
    expect(result.successful.map((s) => s.index)).toEqual([0, 50, 100]);
    expect(result.failed).toEqual([expect.objectContaining({ index: 53, message: 'bad' })]);
    expect(result.unchanged).toEqual(['1', '51', '101']);
  });

  it('deletes collections and saved searches by key with the library precondition', async () => {
    const dels: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      dels.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(null, { status: 204, headers: { 'last-modified-version': '19' } });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.deleteCollections(['C1', 'C2']);
    await client.deleteSearches(['S1']);
    expect(dels[0]!.url).toBe('http://127.0.0.1:23119/api/users/0/collections?collectionKey=C1,C2');
    expect(dels[0]!.headers['If-Unmodified-Since-Version']).toBe('17');
    expect(dels[1]!.url).toBe('http://127.0.0.1:23119/api/users/0/searches?searchKey=S1');
  });

  it("patches at the item's own version when one is given, and at the library's otherwise", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(null, { status: 204, headers: { 'last-modified-version': '20' } });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    expect(await client.patchItem('K1', { title: 'x' }, 12)).toBe(20);
    expect(seen[0]!['If-Unmodified-Since-Version']).toBe('12');
    await client.patchItem('K1', { title: 'y' });
    expect(seen[1]!['If-Unmodified-Since-Version']).toBe('20');
  });

  it('stores full text with a PUT, and tells a missing attachment from a missing endpoint', async () => {
    let answer: Response = new Response(null, { status: 204, headers: { 'last-modified-version': '21' } });
    const puts: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return probeResponse();
      puts.push({ url, body: JSON.parse(String(init.body)) });
      return answer;
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.setFullText('PDF00001', { content: 'text', indexedPages: 2, totalPages: 3 });
    expect(puts[0]).toEqual({
      url: 'http://127.0.0.1:23119/api/users/0/items/PDF00001/fulltext',
      body: { content: 'text', indexedPages: 2, totalPages: 3 },
    });

    // "Not found" is the item: it must not read as a missing write endpoint, or the write is
    // sent to the cloud to fail again there.
    answer = new Response('Not found', { status: 404 });
    const missing = await client.setFullText('PARENT01', { content: 'x' }).catch((e: Error) => e);
    expect((missing as Error).message).toMatch(/No stored file attachment PARENT01/);
    expect(isLocalWritesUnavailable(missing)).toBe(false);

    answer = new Response('No endpoint found', { status: 404 });
    const noEndpoint = await client.setFullText('PDF00001', { content: 'x' }).catch((e: Error) => e);
    expect(isLocalWritesUnavailable(noEndpoint)).toBe(true);
  });

  it('reports a read-only local API (Zotero 9 and earlier) as "not supported"', async () => {
    // 9.x answers reads fine but never sends Zotero-Server-ID, since writes do not exist.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const client = makeClient(fetchImpl, { key: 'k' });
    await expect(client.writeItems([{ itemType: 'book' }])).rejects.toThrow(/not supported/i);
  });
});
