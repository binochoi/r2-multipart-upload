// r2-multipart-upload/server — R2 S3 호환 API 로 presign·멀티파트를 다루는 프레임워크 무관 헬퍼.
// 워커 런타임(WebCrypto)에서 돈다. 두 종류의 "sign" 이 섞여 있다:
//   1) presign*: AwsClient.sign(signQuery) — 로컬 암호 연산(네트워크 0회). 브라우저가
//      돌려받은 URL 로 R2 에 직접 PUT.
//   2) createMultipartUpload/complete/listParts/abort: AwsClient.fetch — Worker 가
//      서명한 요청을 R2 S3 endpoint 로 실제 전송(네트워크 있음).
// signQuery 는 host 만 서명하므로
// Content-Type 을 서명에 넣지 않아야 브라우저가 자유로운 Content-Type 으로 PUT 해도
// SignatureDoesNotMatch 가 안 난다.

import { AwsClient } from "aws4fetch";

/** R2 S3 호환 API 접속 설정. 라우트가 워커 env 에서 구성해 넘긴다. */
export interface R2S3Config {
  /** Cloudflare account id (= https://{accountId}.r2.cloudflarestorage.com). */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function clientFor(cfg: R2S3Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
}

/** key 는 슬래시를 포함할 수 있으나 안전한 문자만 담긴다고 가정하고 raw 로 URL 에 넣는다. */
function objectUrl(cfg: R2S3Config, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`;
}

/** S3 에러 응답을 진단 가능한 메시지로 감싼다(본문에 <Code>/<Message> 가 들어온다). */
async function ensureOk(res: Response, op: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new Error(`R2 ${op} failed: ${res.status} ${res.statusText} ${body}`.trim());
}

/** XML 요소값 하나를 뽑는다(첫 매치). 워커엔 DOMParser 가 없어 정규식으로 파싱한다. */
function extractTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m?.[1];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 진행 중인 멀티파트 하나를 가리킨다. */
export type MultipartRef = { key: string; uploadId: string };

export type PresignPutInput = { key: string; expiresSec?: number };
export type PresignUploadPartInput = MultipartRef & {
  /** 1-based. */
  partNumber: number;
  expiresSec?: number;
};

// ── 유형1: presigned URL 발급(로컬 서명, 네트워크 없음) ──────────────────────

/** 파일 전체를 PUT 할 presigned URL(단일 업로드). */
export async function presignPut(cfg: R2S3Config, input: PresignPutInput): Promise<string> {
  const { key, expiresSec = 300 } = input;
  const client = clientFor(cfg);
  const url = new URL(objectUrl(cfg, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client.sign(url.toString(), { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

/** 멀티파트의 한 파트를 PUT 할 presigned URL. partNumber 는 1-based. */
export async function presignUploadPart(
  cfg: R2S3Config,
  input: PresignUploadPartInput,
): Promise<string> {
  const { key, uploadId, partNumber, expiresSec = 3600 } = input;
  const client = clientFor(cfg);
  const url = new URL(objectUrl(cfg, key));
  url.searchParams.set("partNumber", String(partNumber));
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client.sign(url.toString(), { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

// ── 유형2: 멀티파트 관리(Worker 가 서명해 직접 호출) ─────────────────────────

/** 멀티파트 업로드를 개시하고 uploadId 를 돌려준다. contentType 은 여기서 지정하면
 *  완성된 오브젝트에 그대로 기록된다. */
export async function createMultipartUpload(
  cfg: R2S3Config,
  input: { key: string; contentType: string },
): Promise<string> {
  const { key, contentType } = input;
  const client = clientFor(cfg);
  const res = await ensureOk(
    await client.fetch(`${objectUrl(cfg, key)}?uploads`, {
      method: "POST",
      headers: { "content-type": contentType },
    }),
    "createMultipartUpload",
  );
  const xml = await res.text();
  const uploadId = extractTag(xml, "UploadId");
  if (!uploadId) throw new Error(`R2 createMultipartUpload: UploadId missing in response: ${xml}`);
  return uploadId;
}

/** 이미 올라간 파트 목록(번호·ETag·크기). 재개 대조 + complete 시 파트 확정에 쓴다.
 *  R2 는 최대 1000 파트라 페이지네이션 없이 한 번에 받는다(우리 파트 수는 그보다 훨씬 적다). */
export async function listParts(
  cfg: R2S3Config,
  upload: MultipartRef,
): Promise<{ partNumber: number; etag: string; size: number }[]> {
  const { key, uploadId } = upload;
  const client = clientFor(cfg);
  const res = await ensureOk(
    await client.fetch(`${objectUrl(cfg, key)}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: "GET",
    }),
    "listParts",
  );
  const xml = await res.text();
  const parts: { partNumber: number; etag: string; size: number }[] = [];
  for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const block = m[1];
    const partNumber = Number(extractTag(block, "PartNumber"));
    const etag = extractTag(block, "ETag");
    const size = Number(extractTag(block, "Size") ?? "0");
    if (Number.isFinite(partNumber) && etag) parts.push({ partNumber, etag, size });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

/** 멀티파트를 완성한다. parts 는 partNumber 오름차순이어야 한다(호출부/여기서 정렬).
 *  ETag 는 listParts 가 준 값을 그대로 넣는다(따옴표 포함). */
export async function completeMultipartUpload(
  cfg: R2S3Config,
  input: MultipartRef & { parts: { partNumber: number; etag: string }[] },
): Promise<void> {
  const { key, uploadId, parts } = input;
  const client = clientFor(cfg);
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const body =
    `<CompleteMultipartUpload>` +
    sorted
      .map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
      )
      .join("") +
    `</CompleteMultipartUpload>`;
  const res = await client.fetch(`${objectUrl(cfg, key)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    body,
  });
  await ensureOk(res, "completeMultipartUpload");
  // R2 는 200 으로도 본문에 <Error> 를 담아 실패를 알릴 수 있다(S3 호환 특성).
  const xml = await res.text();
  if (xml.includes("<Error>")) {
    throw new Error(`R2 completeMultipartUpload returned error body: ${xml}`);
  }
}

/** 진행 중인 멀티파트를 폐기한다(업로드된 파트 R2 스토리지도 정리됨). */
export async function abortMultipartUpload(cfg: R2S3Config, upload: MultipartRef): Promise<void> {
  const { key, uploadId } = upload;
  const client = clientFor(cfg);
  await ensureOk(
    await client.fetch(`${objectUrl(cfg, key)}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
    }),
    "abortMultipartUpload",
  );
}
