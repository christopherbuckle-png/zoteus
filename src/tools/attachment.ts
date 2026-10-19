import { z } from 'zod';
import { zoteroObject } from './common-output.js';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';
import { callerRoot } from './caller-root.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import { libraryArgs } from './common-args.js';
import { writeTarget } from './common-output.js';
import {
  desktopTakesWrites,
  isLocalWritesUnavailable,
  ok,
  optionalLibrary,
  requireCloud,
  resolveLibrary,
} from '../registry/registry.js';
import { uploadFile, downloadFile } from '../api/attachments.js';
import {
  AttachmentDownloadError,
  AttachmentUploadError,
  readAttachmentSource,
  storeCloudAttachment,
  storeLocalAttachment,
} from '../features/attachments/store.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const attachment: ToolDefinition = {
  name: 'zotero_attachment',
  title: 'Zotero attachments (files)',
  description:
    "Upload, download, or inspect attachment files. `action`: \"upload\" stores a file as a Zotero attachment using the full File Storage protocol (provide `url` to have Zoteus fetch it, or `file_path` for a file on the machine running Zoteus; optional `parent_item` to attach it under an item, `title`, `content_type`) and returns the new attachment key; \"download\" fetches an attachment's file to a local path (provide `item_key`; optional `save_path`, default under the Zoteus data dir) and returns the path and byte count; \"info\" returns an attachment item's metadata. File bytes are written to / read from disk, never streamed through the conversation. Upload and download go through the running Zotero desktop app (Zotero 10+, no cloud key and no storage quota) for your personal library and any group library the app holds, and through the cloud Web API and your file-storage quota otherwise; `target` (upload) and `readFrom` (download) say which. When Zoteus runs on a different machine than Zotero, `file_path` refers to the server's disk, so use `url` instead.",
  inputSchema: {
    action: z
      .enum(['upload', 'download', 'info'])
      .describe(
        'What to do. "upload" stores a file as an attachment (needs `file_path` or `url`); "download" writes an attachment\'s file to disk (needs `item_key`); "info" returns the attachment item\'s metadata.',
      ),
    file_path: z.string().optional().describe('File to upload, on the machine running Zoteus.'),
    url: z.string().url().optional().describe('URL to download and upload instead of `file_path`; works on remote/hosted servers.'),
    parent_item: z.string().optional().describe('Parent item key to attach under (upload).'),
    title: z.string().optional().describe('Attachment title (upload), e.g. "Full Text PDF"; the filename is used when omitted.'),
    content_type: z.string().optional().describe('MIME type of the uploaded file, e.g. "application/pdf"; inferred from the filename when omitted.'),
    item_key: z.string().optional().describe('Attachment item key (download/info).'),
    save_path: z.string().optional().describe('Where to write the downloaded file.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Allow `save_path` to replace a file that already exists (default false).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      attachment: zoteroObject.optional().describe("action:\"info\": the attachment item's full record."),
      key: z.string().optional().describe('action:"upload": key of the attachment item created.'),
      exists: z.boolean().optional().describe('True when Zotero already held these bytes and only the item was created.'),
      filename: z.string().optional().describe('File name stored.'),
      bytes: z.number().optional().describe('Bytes uploaded or written.'),
      savePath: z.string().optional().describe('action:"download": where the file was written.'),
      contentType: z.string().optional().describe('MIME type of the downloaded file.'),
      target: writeTarget,
      readFrom: z
        .string()
        .optional()
        .describe('action:"download": which copy the bytes came from, "local" (the running Zotero desktop app reading its own storage) or "cloud" (Zotero file storage).'),
    })
    .passthrough(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    // Caller-supplied paths are resolved first, before any library or network work: on a
    // shared deployment they address the operator's disk, not the caller's.
    //
    // The root is the CALLER's subtree, not the whole data directory. Confining to the data
    // directory keeps a path off the operator's disk but says nothing about the other
    // tenants sharing it, and `action:"upload"` reads the file it is given: a caller who
    // named another tenant's path got that tenant's bytes copied into their own library.
    // Everything Zoteus writes for a caller now lives under their own root (see callerRoot),
    // so this is the same rule applied to reads that the document writer applies to writes.
    const root = await callerRoot(ctx);
    let uploadPath = args.file_path;
    let savePath: string | undefined;
    try {
      if (uploadPath) {
        uploadPath = await resolveCallerPath(uploadPath, {
          dataDir: root,
          confined: ctx.remoteCaller,
          mode: 'read',
          argName: 'file_path',
          alternative: 'Use `url` instead: Zoteus fetches the bytes itself, which works on every setup.',
        });
      }
      if (args.save_path) {
        savePath = await resolveCallerPath(args.save_path, {
          dataDir: root,
          confined: ctx.remoteCaller,
          mode: 'write',
          argName: 'save_path',
          alternative: 'Omit `save_path` to write to the default location under the data directory.',
        });
        // Only a caller-supplied path is protected: the default location is Zoteus's own
        // cache for this attachment key, and re-downloading over it is the ordinary case.
        if (!args.overwrite && existsSync(savePath)) {
          return err(
            `\`${savePath}\` already exists. Pass \`overwrite: true\` to replace it, or choose another \`save_path\`.`,
          );
        }
      }
    } catch (e) {
      if (e instanceof CallerPathError) return err(e.message);
      throw e;
    }

    if (args.action === 'info') {
      if (!args.item_key) return err('`item_key` is required for info.');
      const library = optionalLibrary(args, ctx);
      const item = await ctx.router.getItem(args.item_key, { library });
      return ok({ attachment: item }, `Attachment ${args.item_key}: ${item?.data?.filename ?? item?.data?.title ?? '(unnamed)'}.`);
    }

    const lib = resolveLibrary(ctx, args);

    if (args.action === 'upload') {
      if (!args.file_path && !args.url) return err('`file_path` or `url` is required for upload.');
      // Desktop first for any library the app holds: no cloud key, no quota, and the bytes
      // never leave the machine. With neither path, this says so before any bytes are read.
      const useLocal = await desktopTakesWrites(ctx, lib);
      if (!useLocal) requireCloud(ctx, lib);
      // A URL is fetched here and uploaded from memory, so the bytes never have to exist on
      // the server's disk. A path for the cloud still goes through the file reader, which
      // picks up the real mtime; for the desktop it is read here like a URL's bytes.
      let source: Awaited<ReturnType<typeof readAttachmentSource>> | undefined;
      if (args.url || useLocal) {
        try {
          source = await readAttachmentSource(
            ctx,
            args.url
              ? { url: args.url, contentType: args.content_type, titleHint: args.title }
              : { path: uploadPath, contentType: args.content_type },
          );
        } catch (e) {
          if (!(e instanceof AttachmentDownloadError)) throw e;
          return err(e.message);
        }
      }
      if (useLocal && source) {
        const { bytes, filename, contentType } = source;
        try {
          const key = await storeLocalAttachment(
            ctx,
            { parent: args.parent_item, bytes, filename, contentType, title: args.title, url: args.url },
            lib,
          );
          return ok(
            { key, exists: false, filename, bytes: bytes.length, target: 'local' },
            `Stored ${filename} (${bytes.length} bytes) as attachment ${key}` +
              (args.parent_item ? ` under ${args.parent_item}` : '') +
              ' via the Zotero desktop app.',
          );
        } catch (e) {
          // Zotero 9 and earlier answer the write endpoints with 404/501. That fails before
          // anything is created, so with a cloud key the same bytes can still go up the Web
          // API. A failure after the item exists must not retry: a second attempt would
          // leave the empty first attachment behind.
          if (e instanceof AttachmentUploadError || !isLocalWritesUnavailable(e) || !ctx.capabilities.cloud) throw e;
          ctx.logger.info(
            `Local-API attachment writes unavailable (${e instanceof Error ? e.message : e}); using the cloud Web API.`,
          );
          requireCloud(ctx, lib);
        }
      }
      if (source && args.url) {
        const stored = await storeCloudAttachment(ctx, lib, {
          parent: args.parent_item,
          bytes: source.bytes,
          filename: source.filename,
          contentType: source.contentType,
          title: args.title,
          url: args.url,
        });
        return ok(
          { key: stored.key, exists: stored.exists, filename: source.filename, bytes: source.bytes.length, target: 'cloud' },
          stored.exists
            ? `File already in storage; attachment item ${stored.key} created for ${source.filename}.`
            : `Uploaded ${source.filename} (${source.bytes.length} bytes) as attachment ${stored.key}.`,
        );
      }
      const result = await uploadFile(ctx.web, lib, {
        filePath: uploadPath!,
        parentItem: args.parent_item,
        title: args.title,
        contentType: args.content_type,
      });
      const msg = result.exists
        ? `File already in storage; attachment item ${result.key} created for ${result.filename}.`
        : `Uploaded ${result.filename} as attachment ${result.key}.`;
      return ok({ key: result.key, exists: result.exists, filename: result.filename, target: 'cloud' }, msg);
    }

    // download
    if (!args.item_key) return err('`item_key` is required for download.');
    // Under the caller's own root, for the same reason the confinement above is: on a shared
    // deployment two tenants downloading the same item key would otherwise write to, and read
    // back, one path. On stdio `root` IS the data directory, so this is the previous location.
    savePath ??= join(root, 'attachments', args.item_key);
    await mkdir(dirname(savePath), { recursive: true });
    const local = await downloadFromDesktop(ctx, lib, args.item_key, savePath);
    if ('savePath' in local) {
      return ok(
        { savePath: local.savePath, bytes: local.bytes, contentType: local.contentType, readFrom: 'local' },
        `Downloaded ${local.bytes} bytes to ${local.savePath} from the Zotero desktop app's own copy.`,
      );
    }
    if (!ctx.capabilities.cloud) {
      return err(
        local.why
          ? `The Zotero desktop app could not produce the file of ${args.item_key} (${local.why}), and no cloud API key is configured to download it from Zotero file storage instead.`
          : `Downloading the file of ${args.item_key} needs the Zotero desktop app running with this library in it (it reads the file off its own disk), or a cloud API key with file access (set ZOTERO_API_KEY; create one at https://www.zotero.org/settings/keys). Neither is available right now.`,
      );
    }
    const r = await downloadFile(ctx.web, lib, args.item_key, savePath);
    return ok(
      { savePath: r.savePath, bytes: r.bytes, contentType: r.contentType, readFrom: 'cloud' },
      `Downloaded ${r.bytes} bytes to ${r.savePath}.` +
        (local.why ? ` The Zotero desktop app could not produce it (${local.why}), so it came from Zotero file storage.` : ''),
    );
  },
};

/**
 * The attachment's file from the running desktop app's own storage, written to `savePath`,
 * when reads of this library go to the app (it holds the library, and no cloud write to it
 * is still waiting for the app to sync). `{ why }` when the app was asked and could not
 * produce it: no such attachment there, a file never downloaded to this computer, a linked
 * file that has moved. The cloud may still have it, so that is a reason, not a failure.
 */
async function downloadFromDesktop(
  ctx: ToolContext,
  lib: LibraryRef,
  key: string,
  savePath: string,
): Promise<{ savePath: string; bytes: number; contentType?: string } | { why?: string }> {
  if (!ctx.local || !(await ctx.router.readsLocally(lib))) return {};
  let bytes: Uint8Array;
  try {
    bytes = await ctx.local.downloadFileBytes(key, lib);
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
  if (!bytes.byteLength) return { why: 'it returned an empty file' };
  await writeFile(savePath, bytes);
  // The type the attachment records, for parity with the cloud's Content-Type. Best effort:
  // the bytes are already on disk, and a missing type is not worth failing them over.
  const item = await ctx.local.getItem(key, {}, lib).catch(() => null);
  const contentType = item?.data?.contentType ?? item?.contentType;
  return { savePath, bytes: bytes.byteLength, contentType: typeof contentType === 'string' && contentType ? contentType : undefined };
}

export default attachment;
