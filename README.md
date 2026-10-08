# r2-multipart-upload

**Resumable, direct-to-R2 file uploads from the browser for Cloudflare Workers.** `r2-multipart-upload` issues
**presigned URLs** through the R2 **S3-compatible API**, manages **S3 multipart uploads**
(create / list parts / complete / abort), and ships a browser **chunked upload engine** with
concurrency, retries, **upload progress** and **pause / resume / cancel**. The bytes go straight from
the browser to Cloudflare R2, so your Worker only signs requests and never proxies file data. It's
framework-agnostic TypeScript (Hono, Next.js, Remix, plain Workers), and the server side runs on
WebCrypto through [`aws4fetch`](https://github.com/mhart/aws4fetch).

## Why

Streaming file bytes through a Worker runs into CPU, memory and request-size limits. With an R2
presigned URL, the browser `PUT`s directly to R2 and the Worker only handles signatures and metadata.
On top of that, large uploads need two more things:

- **Large files.** A single `PUT` that fails has to start over. `r2-multipart-upload` splits large files into S3
  multipart parts, and after an interruption it **keeps the uploaded parts and only sends the rest**.
- **One shared contract.** Signing and multipart state don't get scattered across route handlers.
  Server and client share the same wire types and constants (part size, multipart threshold).

The package only covers *how* bytes get to R2. It knows nothing about auth, your domain or your
database. Things like choosing the object key stay in your app.

## Use cases

- Uploading large videos or attachments (hundreds of MB up to 5 GiB) from a web app backed by
  Cloudflare Workers, with a progress bar and pause / resume / cancel.
- Resuming an interrupted upload after a page reload or app restart, using the same file and its
  `recordId`.
- Small files (avatars, images) via a single presigned `PUT`. Files ≤ 16 MiB take this path
  automatically.
- Adding R2 direct uploads to any framework. Drop the server helpers into your routes and implement a
  small `UploadBackend` interface on the client.

## Install

```sh
npm install r2-multipart-upload
# or
pnpm add r2-multipart-upload
```

## Entry points

| import | Runtime | Contents |
| --- | --- | --- |
| `r2-multipart-upload/shared` | any | Wire types and constants (`PART_SIZE`, `MULTIPART_THRESHOLD`, `MAX_UPLOAD_BYTES`, `partCountFor`, DTOs). Zero dependencies |
| `r2-multipart-upload/server` | Workers (WebCrypto) | Presigning and multipart management for R2's S3 API |
| `r2-multipart-upload/client` | Browser | Chunked upload engine: concurrency, retries, progress, pause / resume / cancel |

## Usage

### Server (inside a route)

```ts
import { createMultipartUpload, presignUploadPart, presignPut } from "r2-multipart-upload/server";
import { partCountFor, PART_SIZE, MULTIPART_THRESHOLD } from "r2-multipart-upload/shared";

const cfg = { accountId, accessKeyId, secretAccessKey, bucket }; // from your Worker env

// Your app decides the object key
const key = `uploads/${crypto.randomUUID()}`;

if (size <= MULTIPART_THRESHOLD) {
  const putUrl = await presignPut(cfg, { key, expiresSec: 300 });
  return { recordId, key, kind: "single", putUrl };
}
const uploadId = await createMultipartUpload(cfg, { key, contentType });
const partUrls = await Promise.all(
  Array.from({ length: partCountFor(size) }, (_, i) =>
    presignUploadPart(cfg, { key, uploadId, partNumber: i + 1 }).then((url) => ({
      partNumber: i + 1,
      url,
    })),
  ),
);
return { recordId, key, kind: "multipart", uploadId, partSize: PART_SIZE, partUrls };
```

On `complete`, collect the ETags with `listParts`, then call `completeMultipartUpload` and verify the
object size with a `HEAD` (for example through your R2 binding) before marking the upload ready.

### Client

```ts
import { createUploadEngine, type UploadBackend } from "r2-multipart-upload/client";

// Implement the server calls with your own API client.
const backend: UploadBackend = {
  create: (input) => api.uploads.create(input),
  getParts: (id) => api.uploads.parts(id), // for resume
  complete: (id) => api.uploads.complete(id),
  abort: (id) => api.uploads.abort(id),
};

const engine = createUploadEngine(backend);
const handle = engine.start(file, {
  concurrency: 3,
  onProgress: (loaded, total) => setPercent((loaded / total) * 100),
});

handle.pause(); // stops in-flight parts (finished parts stay on R2)
handle.resume(); // continues with the remaining parts
await handle.cancel(); // also calls abort on the server
const uploaded = await handle.promise; // metadata once complete

// Resume after a reload: same file + recordId
engine.resume(file, { recordId }).promise;
```

## API

### `r2-multipart-upload/server`

All functions take an `R2S3Config` (`{ accountId, accessKeyId, secretAccessKey, bucket }`) as the
first argument.

| Function | Description |
| --- | --- |
| `presignPut(cfg, { key, expiresSec? })` | Presigned URL for a single `PUT` of the whole file (default expiry 300 s). Signed locally, no network |
| `presignUploadPart(cfg, { key, uploadId, partNumber, expiresSec? })` | Presigned URL for one multipart part, 1-based (default expiry 3600 s). Signed locally |
| `createMultipartUpload(cfg, { key, contentType })` | Starts a multipart upload and returns its `uploadId`. `contentType` is stored on the final object |
| `listParts(cfg, { key, uploadId })` | Parts already on R2 (`{ partNumber, etag, size }[]`), used for resume and complete |
| `completeMultipartUpload(cfg, { key, uploadId, parts })` | Completes the upload from `{ partNumber, etag }[]` |
| `abortMultipartUpload(cfg, { key, uploadId })` | Aborts the upload and frees its stored parts |

### `r2-multipart-upload/client`

- `createUploadEngine(backend: UploadBackend)` returns `{ start, resume }`.
  - `start(file, options?)` starts a new upload.
  - `resume(file, { recordId, ...options })` skips the parts the server already has.
- Both return an `UploadHandle`: `{ promise, pause(), resume(), cancel() }`.
- `StartOptions`:
  - `onProgress(loaded, total)`
  - `concurrency` (default 3)
  - `maxRetries` (default 3, exponential backoff)
  - `partTimeoutMs` (default 60 000)
- `UploadBackend`: `create(input)`, `getParts(recordId)`, `complete(recordId)`, `abort(recordId)`.

### `r2-multipart-upload/shared`

- Constants: `PART_SIZE` (16 MiB), `MULTIPART_THRESHOLD` (16 MiB), `MAX_UPLOAD_BYTES` (5 GiB)
- Helper: `partCountFor(size, partSize?)`
- Types:
  - `UploadStatus`, `UploadKind`
  - `CreateUploadInput`, `CreateUploadResult`, `PartUrl`
  - `PartsResult`, `CompletedUpload`

## Flow

```
browser (client)                 Worker (server route)              R2 (S3 API)
  start(file) ──create──▶  presignPut / createMultipartUpload ──▶ presigned URLs
     │  ◀── putUrl/partUrls ──────────┘
     ├─ PUT parts directly to R2 with the presigned URLs ─────────────────────▶
     └─ complete ─────────▶  listParts + completeMultipartUpload ──▶ object finalized
                             └─ HEAD to re-check size → return metadata
```

Key rules:

- **The server doesn't trust the client's size.** The `size` the client sends is re-checked with
  `HEAD` on `complete`.
- **The client never reads part ETags.** The Worker collects them with `listParts` on `complete`, so
  you don't need CORS `ExposeHeaders: ETag`.
- Files with `size ≤ MULTIPART_THRESHOLD` (16 MiB) use a single `PUT`; larger files use multipart.

## Notes

- **`Content-Type` isn't part of the signature** (only `host` is signed). The browser can `PUT` with
  any `Content-Type` without a `SignatureDoesNotMatch` error. The final object's `Content-Type` is set
  in `createMultipartUpload`.
- Workers have no `DOMParser`, so S3 XML responses are parsed with regular expressions.
- R2 can answer `complete` with HTTP 200 and an `<Error>` in the body, so the body is checked too.
- When `File.type` is empty (common for `webm`, `mkv` and other media), the client engine infers the
  type from the file extension. It sends the same `Content-Type` to `create` and to the R2 `PUT`.
- Your R2 bucket needs a CORS rule that allows `PUT` from your app's origin.

## License

MIT
