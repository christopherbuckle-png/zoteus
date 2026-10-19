import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import annotate, { normalizePosition, buildSortIndex } from '../../src/tools/annotate.js';

describe('annotate helpers', () => {
  it('normalizes shorthand [page, rect] positions', () => {
    const pos = normalizePosition([3, [10, 20, 30, 40]]);
    expect(pos).toEqual({ position: { pageIndex: 3, rects: [[10, 20, 30, 40]] } });
  });

  it('normalizes Zotero-form objects and JSON strings', () => {
    const obj = { pageIndex: 4, rects: [[1, 2, 3, 4], [5, 6, 7, 8]] };
    expect(normalizePosition(obj)).toEqual({ position: obj });
    expect(normalizePosition(JSON.stringify(obj))).toEqual({ position: obj });
  });

  it('falls back to a page-only position when no position was given', () => {
    expect(normalizePosition(undefined, 7)).toEqual({ position: { pageIndex: 7, rects: [] } });
    expect(normalizePosition(undefined)).toEqual({ position: null });
    // `rects` is what a highlight needs, not what a position IS: a page alone is a position.
    expect(normalizePosition({ pageIndex: 3 })).toEqual({ position: { pageIndex: 3, rects: [] } });
  });

  // A rect that was filtered out left `rects: []`, which the handler read as "no position
  // given" and answered by anchoring the passage somewhere else entirely (#78 sibling).
  it('reports a rect that is not four finite numbers instead of dropping it', () => {
    const three = normalizePosition({ pageIndex: 1, rects: [[1, 2, 3]] });
    expect(three.position).toBeNull();
    expect(three.problem).toContain('`position.rects[0]` has 3 value(s), not 4');

    expect(normalizePosition({ pageIndex: 0, rects: [[1, 2, 3, 4], [1, 2, 3, '4']] }).problem)
      .toContain('`position.rects[1]` has "4" at index 3');
    expect(normalizePosition({ pageIndex: 0, rects: [[1, 2, 3, NaN]] }).problem).toContain('NaN');
    expect(normalizePosition([3, [10, 20, 30]]).problem).toContain('`position[1]` has 3 value(s), not 4');
  });

  it('reports a position it cannot read at all, rather than returning nothing', () => {
    expect(normalizePosition('not json').problem).toContain('not JSON');
    expect(normalizePosition({ page: 2 }).problem).toContain('neither `pageIndex` nor `rects`');
    expect(normalizePosition({ pageIndex: '0', rects: [] }).problem).toContain('not a 0-based page index');
    expect(normalizePosition([0, [1, 2, 3, 4], 9]).problem).toContain('array of 3 value(s)');
    expect(normalizePosition(42).problem).toContain('is a number');
  });

  it('builds reader-compatible sort indexes', () => {
    // Mirrors the real annotation "00004|001235|00636" shape (A4-ish page height).
    const rects = [[70.944, 196.106, 297.615, 205.162]];
    expect(buildSortIndex(4, rects, { offset: 1235, pageHeight: 841.162 })).toBe('00004|001235|00636');
    expect(buildSortIndex(0, [], {})).toBe('00000|000000|00000');
    expect(buildSortIndex(12, [[0, 10, 100, 50]], { pageHeight: 792 })).toBe('00012|000000|00742');
    // The measured defect: the same rects sort to the top of the page without a height.
    expect(buildSortIndex(0, [[72, 696, 300, 712]], {})).toBe('00000|000000|00000');
    expect(buildSortIndex(0, [[72, 696, 300, 712]], { pageHeight: 792 })).toBe('00000|000000|00080');
  });
});

// `z.object` strips what it does not recognise, so `pageLabel: "xx"` and
// `sortIndex: "09999|000999|00999"` were dropped before the handler saw them and the call
// reported success over an annotation stored with a page label of "1" and a computed sort
// index. Measured against a real Zotero desktop before this was fixed.
describe('zotero_annotate refuses annotation fields it does not know', () => {
  const parse = (annotation: Record<string, unknown>) =>
    z.object(annotate.inputSchema).safeParse({ parent: 'ATT1', annotations: [annotation] });

  it('names the offending key and the spelling this tool uses', () => {
    const res = parse({ type: 'highlight', text: 'x', pageLabel: 'xx', sortIndex: '09999|000999|00999' });
    expect(res.success).toBe(false);
    const messages = res.error!.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('unknown field `pageLabel`: this tool spells it `page_label`');
    expect(messages).toContain('unknown field `sortIndex`: this tool spells it `sort_index`');
    // The path is what tells a caller WHICH annotation of a batch was wrong.
    expect(res.error!.issues[0]!.path).toEqual(['annotations', 0]);
  });

  it('pairs Zotero’s own data-model spellings with their argument names', () => {
    const res = parse({ type: 'note', annotationComment: 'hi' });
    expect(res.error!.issues[0]!.message).toContain('this tool spells it `comment`');
  });

  it('lists the fields when the key resembles none of them', () => {
    const res = parse({ type: 'note', comment: 'hi', colour: '#fff' });
    expect(res.error!.issues[0]!.message).toContain('unknown field `colour`. The fields are: type, text');
  });

  it('still accepts every field it documents', () => {
    const res = parse({
      type: 'highlight', text: 'x', comment: 'c', color: '#ffd400', page: 1, page_label: 'ix',
      position: { pageIndex: 1, rects: [[1, 2, 3, 4]] }, occurrence: 2, sort_index: '00001|000000|00010',
      char_offset: 5, page_height: 792, tags: ['t'],
    });
    expect(res.success).toBe(true);
  });
});

describe('zotero_annotate action:"delete"', () => {
  it('trashes annotations by flag rather than erasing them via the local API DELETE', async () => {
    const setDeleted = vi.fn(async () => ({
      successful: [{ index: 0, key: 'ANN1', version: 4 }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 4,
    }));
    const deleteItems = vi.fn(async () => undefined);
    const ctx: any = {
      capabilities: { cloud: null, localApi: true },
      localWrites: { setDeleted, deleteItems },
      router: { defaultLibrary: () => ({ type: 'user', id: 0 }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const res = await annotate.handler({ action: 'delete', annotation_keys: ['ANN1'] }, ctx);
    expect(setDeleted).toHaveBeenCalledWith(['ANN1'], 1, { type: 'user', id: 0 });
    expect(deleteItems).not.toHaveBeenCalled();
    expect(res.structuredContent?.trashed).toEqual(['ANN1']);
  });

  // The local branch collected per-item outcomes and returned them as success, so a key
  // Zotero refused read as "Trashed 0 annotation(s)" with no error flag and the 400 buried
  // in `failed`. The cloud branch already said "; N failed."; this one said nothing.
  it('reports a delete where every key failed as an error, not as "Trashed 0"', async () => {
    const ctx: any = {
      capabilities: { cloud: null, localApi: true },
      localWrites: {
        setDeleted: vi.fn(async () => ({
          successful: [],
          unchanged: [],
          failed: [{ index: 0, code: 400, message: 'itemType property not provided', key: 'ZZZZZZZZ' }],
          newLibraryVersion: 4,
        })),
        deleteItems: vi.fn(),
      },
      router: { defaultLibrary: () => ({ type: 'user', id: 0 }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const res = await annotate.handler({ action: 'delete', annotation_keys: ['ZZZZZZZZ'] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Nothing succeeded');
    expect(res.content[0].text).toContain('itemType property not provided');
  });

  it('keeps a partial delete a success but says how many failed', async () => {
    const ctx: any = {
      capabilities: { cloud: null, localApi: true },
      localWrites: {
        setDeleted: vi.fn(async () => ({
          successful: [{ index: 0, key: 'ANN1', version: 4 }],
          unchanged: [],
          failed: [{ index: 1, code: 400, message: 'nope', key: 'ZZZZZZZZ' }],
          newLibraryVersion: 4,
        })),
        deleteItems: vi.fn(),
      },
      router: { defaultLibrary: () => ({ type: 'user', id: 0 }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const res = await annotate.handler({ action: 'delete', annotation_keys: ['ANN1', 'ZZZZZZZZ'] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('1 failed.');
  });
});

// One page of Helvetica, so the anchoring path runs against real pdfjs geometry.
const MINIMAL_PDF = new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 41 >> stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`);

function anchoringCtx(overrides: any = {}) {
  const writeItems = vi.fn(async (items: any[]) => ({
    successful: items.map((_, i) => ({ index: i, key: `ANN${i}`, version: 1 })),
    unchanged: [],
    failed: [],
    newLibraryVersion: 1,
  }));
  const ctx: any = {
    capabilities: { cloud: null, localApi: true },
    config: { local: 'auto' },
    localWrites: { writeItems },
    local: {
      downloadFileBytes: vi.fn(async () => MINIMAL_PDF),
      getItemChildren: vi.fn(async () => ({ data: [] })),
    },
    router: {
      getItem: vi.fn(async () => ({ data: { itemType: 'attachment', key: 'ATT1', contentType: 'application/pdf' } })),
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return { ctx, writeItems };
}

describe('zotero_annotate anchors a highlight from its text', () => {
  it('computes page rects for a passage given without a position', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', comment: 'from text alone' }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const [written] = writeItems.mock.calls[0]![0] as any[];
    const pos = JSON.parse(written.annotationPosition);
    expect(pos.pageIndex).toBe(0);
    expect(pos.rects).toHaveLength(1);
    // Text is drawn at x=20 on a 200pt page: the rect must sit there, not at a made-up origin.
    expect(pos.rects[0][0]).toBeCloseTo(20, 0);
    expect(pos.rects[0][2]).toBeGreaterThan(pos.rects[0][0]);
    expect(written.annotationText).toBe('Hello PDF');
    // The sort index must come from the located offset and real page height, not from zeros.
    expect(written.annotationSortIndex).toMatch(/^00000\|\d{6}\|\d{5}$/);
    expect(res.structuredContent?.anchoredFromText).toBe(1);
  });

  it('refuses to guess when the passage is not in the PDF, and writes nothing', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'a passage this PDF does not contain' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('passage not found');
    expect(writeItems).not.toHaveBeenCalled();
  });

  it('stores an explicitly positioned highlight exactly where the caller put it', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', position: [0, [1, 2, 3, 4]] }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const [written] = writeItems.mock.calls[0]![0] as any[];
    expect(JSON.parse(written.annotationPosition)).toEqual({ pageIndex: 0, rects: [[1, 2, 3, 4]] });
    expect(res.structuredContent?.anchoredFromText).toBe(0);
  });

  // Measured against a real Zotero: a hand-placed highlight was stored with
  // "00000|000000|00000" and sorted to the top of its page in the reader sidebar, because
  // the sort index measures from the page BOTTOM and only the anchoring pass reported a
  // page height. `position` is precisely the path that never anchors.
  it('reads the page height for a caller-supplied position, so it sorts where it sits', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', position: { pageIndex: 0, rects: [[20, 95, 120, 120]] } }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const [written] = writeItems.mock.calls[0]![0] as any[];
    // The fixture page is 200pt tall and the rect's top edge is at 120: 200 - 120 = 80.
    expect(written.annotationSortIndex).toBe('00000|000000|00080');
    // One PDF read serves anchoring and page heights alike, however many annotations ask.
    expect(ctx.local.downloadFileBytes).toHaveBeenCalledTimes(1);
  });

  it('leaves an explicit sort_index or page_height alone, and never opens the PDF for one', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      {
        parent: 'ATT1',
        annotations: [
          { type: 'highlight', text: 'a', position: [0, [20, 95, 120, 120]], sort_index: '00003|000012|00042' },
          { type: 'highlight', text: 'b', position: [0, [20, 95, 120, 120]], page_height: 400 },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const [first, second] = writeItems.mock.calls[0]![0] as any[];
    expect(first.annotationSortIndex).toBe('00003|000012|00042');
    expect(second.annotationSortIndex).toBe('00000|000000|00280');
    expect(ctx.local.downloadFileBytes).not.toHaveBeenCalled();
  });

  it('says so when the page height could not be read, instead of quietly sorting to the top', async () => {
    const { ctx, writeItems } = anchoringCtx();
    // Page 3 of a one-page PDF: the position is still stored, only its order is unknowable.
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', position: [2, [1, 2, 3, 4]] }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('sort to the top of their page');
    const [written] = writeItems.mock.calls[0]![0] as any[];
    expect(written.annotationSortIndex).toBe('00002|000000|00000');
  });

  // The rect was filtered out, the position became empty, and the passage was anchored by
  // text instead: a success reporting coordinates the caller never asked for. Measured.
  it('refuses a malformed rect rather than re-anchoring the passage somewhere else', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', position: { pageIndex: 0, rects: [[10, 20, 30]] } }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('annotations[0]: `position.rects[0]` has 3 value(s), not 4');
    expect(writeItems).not.toHaveBeenCalled();
    // The passage is not the caller's mistake here, so the PDF is not read looking for it.
    expect(ctx.local.downloadFileBytes).not.toHaveBeenCalled();
  });

  it('blames the rects, not the passage, when both are wrong', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'not in this PDF', position: { pageIndex: 0, rects: [[10, 20, 30]] } }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('`position.rects[0]`');
    // The old answer told the caller to re-quote their text, and that "no `position` was
    // given" when one had been.
    expect(res.content[0].text).not.toContain('passage not found');
    expect(res.content[0].text).not.toContain('no `position` was given');
    expect(writeItems).not.toHaveBeenCalled();
  });

  it('explains itself when the PDF cannot be read at all', async () => {
    const { ctx, writeItems } = anchoringCtx();
    ctx.local.downloadFileBytes = vi.fn(async () => { throw new Error('no stored copy'); });
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('the PDF could not be read');
    expect(writeItems).not.toHaveBeenCalled();
  });
});
