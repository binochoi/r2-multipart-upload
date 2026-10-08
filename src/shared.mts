// r2-multipart-upload/shared — 서버·클라이언트가 함께 쓰는 순수 타입/상수. React/DOM/워커
// 바인딩 의존이 전혀 없어 양쪽 번들에서 안전하게 import 된다.

/** 업로드 레코드 상태. 서버 DB 의 text pseudo-enum 값과 1:1 로 대응한다.
 *  - pending   : create 로 행만 만들어진 상태(아직 바이트 안 올라옴)
 *  - uploading : 파트 업로드가 진행 중(선택적 — 서버가 안 쓰면 pending 유지 가능)
 *  - ready     : complete 에서 HEAD 검증까지 통과(실제 다운로드 가능)
 *  - aborted   : 사용자가 취소(멀티파트면 R2 쪽도 abort)
 *  - failed    : complete 시 미업로드/크기 불일치로 검증 실패 */
export type UploadStatus = "pending" | "uploading" | "ready" | "aborted" | "failed";

/** 업로드 방식. 임계값 이하 파일은 단일 presigned PUT, 초과는 S3 multipart. */
export type UploadKind = "single" | "multipart";

/** 멀티파트 파트 크기(바이트). R2 S3 multipart 는 "마지막을 제외한 모든 파트가
 *  동일 크기 + 최소 5 MiB" 규약이라 5 MiB 이상이어야 한다. 16 MiB 로 둬 파트 수를
 *  줄이면서 재개 granularity 도 유지한다. */
export const PART_SIZE = 16 * 1024 * 1024;

/** 이 크기 이하는 멀티파트 대신 단일 PUT 로 올린다(오버헤드 회피). PART_SIZE 와
 *  같게 두면 "한 파트로 끝날 파일은 단일 PUT" 이 된다. */
export const MULTIPART_THRESHOLD = PART_SIZE;

/** 방어적 최대 업로드 크기(5 GiB). 서버 create 가 이 값으로 size 를 거른다. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/** size 를 partSize 로 나눈 파트 개수(최소 1). */
export function partCountFor(size: number, partSize: number = PART_SIZE): number {
  return Math.max(1, Math.ceil(size / partSize));
}

// ── 와이어 DTO (라우트 요청/응답) ──────────────────────────────────────────

/** create 요청 body. 바이트는 안 보낸다(클라가 presigned URL 로 R2 에 직접 PUT). */
export interface CreateUploadInput {
  fileName: string;
  contentType: string;
  /** 클라가 신고하는 바이트 크기. **서버는 신뢰하지 않고** complete 시 HEAD 로 재검증한다. */
  size: number;
}

/** 파트 번호(1-based)와 그 파트를 PUT 할 presigned URL 쌍. */
export interface PartUrl {
  partNumber: number;
  url: string;
}

/** create 응답. kind 에 따라 채워지는 필드가 다르다. */
export interface CreateUploadResult {
  recordId: string;
  key: string;
  kind: UploadKind;
  /** single 전용: 파일 전체를 PUT 할 presigned URL. */
  putUrl?: string;
  /** multipart 전용: R2 멀티파트 uploadId. */
  uploadId?: string;
  /** multipart 전용: 파트 크기(바이트). */
  partSize?: number;
  /** multipart 전용: 총 파트 수. */
  partCount?: number;
  /** multipart 전용: 각 파트의 presigned PUT URL. */
  partUrls?: PartUrl[];
}

/** parts(재개) 응답. 이미 올라간 파트 번호와, 아직 안 올라간 파트의 재서명 URL. */
export interface PartsResult {
  partSize: number;
  partCount: number;
  /** 아직 업로드가 안 된 파트들의 presigned URL(재개 시 이것만 올리면 됨). */
  partUrls: PartUrl[];
  /** 서버(listParts)가 확인한, 이미 R2 에 올라간 파트 번호들. */
  uploadedParts: number[];
}

/** complete 성공 시 반환하는 첨부 메타. url 은 앱이 정한 다운로드 경로다. */
export interface CompletedUpload {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string;
  /** ISO8601 문자열(와이어). 앱 레이어에서 Date 로 파싱. */
  createdAt?: string;
}
