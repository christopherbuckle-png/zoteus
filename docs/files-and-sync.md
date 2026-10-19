# Files, full-text, sync, groups & export

M4 rounds out library coverage with five tools; `zotero_attach_file` and `zotero_annotate` were added later and write through the Zotero desktop app when one is reachable, falling back to the cloud Web API when it is not.

## `zotero_groups`
Lists the group libraries your key can access (id, name, type, item count, edit permissions). Pass a returned id as `library_id` (with `library_type:"group"`) to other tools to operate on a group library. `library_type` alone does not address a group: without an id the call is refused rather than falling back to your personal library.

With no key at all it lists the groups a running Zotero 10+ desktop app holds, since those are exactly the ones you can still read. The desktop serves a group's `id`, `name` and `description` plus its own item count, which counts child attachments, notes and trashed items; it does not store `type` or `libraryEditing`, so those are absent from such rows rather than guessed. Where a key and a desktop app are both present the two lists merge into one row per group, each marked `source: "cloud"`, `"local"` or `"both"`.

Reading a group needs the key to have *read* access to it (or a Zotero 10+ desktop app that holds the group, which serves reads with no key at all). **Writing** to one goes through a Zotero 10+ desktop app that holds the group, with no key, and otherwise through the cloud Web API with a key that has write access to that group: see [Group libraries](./writing.md#group-libraries).

## `zotero_export`
Exports items in a machine-readable bibliographic format and returns the raw text:
`bibtex`, `biblatex`, `ris`, `csljson`, `csv`, `mods`, `tei`, `coins`, `rdf_bibliontology`, `rdf_dc`, `rdf_zotero`, `refer`, `wikipedia`, `bookmarks`. Narrow with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` is always applied (export formats require it). For styled, human-readable citations in a CSL style (APA, IEEE, …), use the citation tools.

## `zotero_fulltext`
Read or write attachment full text (only attachment items have it):
- `get` — extracted text + indexing stats (`found:false` when none).
- `set` — store extracted text (`content` + char/page counts).
- `since` — map of attachment keys whose full text changed after a library version (for incremental indexing).

> `get` and `since` are **routed** like every other read: Zotero 7+ serves the same `/fulltext` endpoints from the desktop app, so they need no cloud key when it is running. Group libraries the app does not hold, and everything when the app is closed, go to the cloud Web API. `set` is a write: it goes to the desktop app (Zotero 10+) for any library the app holds, and to the cloud otherwise.

## `zotero_sync`
The version-based delta the Zotero sync algorithm uses. Given `since` (a library version, 0 = everything), returns per-type maps of changed keys (items/collections/searches/tags) plus the deletion log. Fetch only the changed keys afterward — don't re-pull the whole library.

> **Routed**, like every other read, and `backend` says which API answered. The whole delta comes from that one API: the desktop app and the cloud number their library versions independently, so a `since` taken from one means nothing to the other. The desktop app serves item and collection versions with no cloud key; it serves no tag versions and keeps no deletion log, and those are reported in `unavailable` (with the reason and where the answer does live) rather than as empty maps. A call whose every requested part is one the desktop app lacks returns an error instead. To get those parts, read the library from the cloud: a key in `ZOTERO_API_KEY`, and `ZOTEUS_LOCAL=off` if the desktop app is running.

## `zotero_attachment`
Upload, download, or inspect attachment files. File bytes go to/from **disk**, never through the conversation.
- `upload` — store a file via the full 5-step Zotero File Storage protocol (compute md5/mtime → request authorization → upload bytes → register). Give `url` to have Zoteus fetch the file itself, or `file_path` for a file on the machine running Zoteus. Optional `parent_item`, `title`, `content_type`. Returns the new attachment key (and whether the file already existed in storage).
- `download` — fetch an attachment's file to `save_path` (default under the Zoteus data dir); returns the path and byte count. A `save_path` you name will not silently replace a file that is already there: pass `overwrite: true` if that is what you want. The default location is exempt, being Zoteus's own cache for that attachment key.
- `info` — return an attachment item's metadata.

> Uploads/downloads use the cloud Web API and count against your Zotero file-storage quota. For a **key-free** store into the running desktop app, use `zotero_attach_file` instead.
>
> `file_path` is a path on the machine running **Zoteus**, not the machine you are chatting from. On a remote or hosted server those are different machines, so use `url` there.
>
> On a server with OAuth enabled, Zoteus **enforces** that rather than leaving it to the caller: `file_path`, `save_path` and `vocabulary_path` must resolve inside the data directory, and anything else is refused. A caller-supplied path on a shared instance addresses the operator's disk, which is where the token store and the server's own code live. A local stdio install is unaffected, since there the caller already owns the machine.

## `zotero_attach_file`
Store a file as a stored attachment under an existing item. Give `parent` (the item key) and either `url` (Zoteus downloads it, then stores it) or `path` (a file on the machine running Zoteus); `filename` and `content_type` are inferred when omitted, `title` defaults to the filename. arXiv-style URLs carry no extension, so one is appended from the served content type. Returns the new attachment key.

Two backends, picked per call:

- **Desktop** (Zotero 10+ local-API writes) whenever the app is reachable: no cloud key, no storage quota, and the bytes never go through the Web API. Stored as `imported_file`.
- **Cloud** (the Web API's File Storage protocol) otherwise, or for a group library via `library_id`. Needs `ZOTERO_API_KEY` with file access and counts against your Zotero storage quota. A downloaded file is stored as `imported_url` keeping its source URL, which is what Zotero itself records for a PDF pulled off the web.

On Zotero 9 and earlier (a read-only local API) the desktop attempt fails before anything is created, so the call retries on the cloud when a key is configured. A failure *after* the attachment item exists is reported instead of retried, since a second attempt would leave the empty first one behind.

> **Remote and hosted servers.** The desktop local API listens on `127.0.0.1:23119` on **your** machine, so a Zoteus running anywhere else has no route to it and no amount of granting write access in Zotero will change that. There, the cloud path is the only one, and `url` is the way in: the server fetches the bytes itself rather than needing a file on its own disk. See [`writing.md`](./writing.md) for the desktop write paths and the one-time key grant.

## `zotero_annotate`
Add or delete Zotero PDF annotations (highlights, underlines, notes), the same objects the PDF reader creates, so they appear in Zotero's reader sidebar and export with the item. `parent` may be a regular item key (the PDF child is resolved for you) or an attachment key. Highlights need only `text`, the passage itself: Zoteus locates it in the PDF and computes the page rects Zotero anchors a highlight by, following it across line and column breaks. An explicit `position` (`{"pageIndex":N,"rects":[[x1,y1,x2,y2],…]}` in native PDF points, bottom-left origin) overrides that. `annotationSortIndex` is derived from wherever the passage lands. `action:"delete"` trashes annotations by key. Routes to the desktop app for the personal library, else the cloud Web API. Details and examples in [`writing.md`](./writing.md).

> Anchoring needs the PDF bytes, which come from the same three sources `zotero_get_fulltext` uses: the running desktop app, the local Zotero storage folder, then a cloud download. See [`grounding.md`](./grounding.md#where-the-file-bytes-come-from).
