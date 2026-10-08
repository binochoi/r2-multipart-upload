// r2-multipart-upload/client — 청크 분할 재개형 업로드 엔진. 브라우저(XHR/Blob/File/
// AbortController)에서 돈다. 서버와의 대화는 UploadBackend 인터페이스로 추상화해,
// electron/capacitor 가 나중에 같은 엔진을 백그라운드 transport 로 재사용할 수 있다.
//
// 파트 ETag 는 읽지 않는다 — complete 시 Worker 가 listParts 로 수집하므로 CORS
// ExposeHeaders 의존이 없다. 파트 PUT 은 presigned URL 로 R2 에 직접 간다(XHR).

import type { CompletedUpload, CreateUploadInput, CreateUploadResult, PartsResult } from "./shared.mts";

/** 확장자 → MIME 보정표. 브라우저가 File.type 을 비워 주는(OS MIME 미등록/특정 웹뷰)
 *  미디어 파일을 확장자로 복구한다. 여기서 정한 값이 곧 DB contentType(정본)이 되고,
 *  프론트는 이 값의 `video/` 접두어로 미리보기·재생을 판별한다. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  // video
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  // audio
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

/** 업로드할 파일의 contentType 을 결정한다. 브라우저가 준 File.type 이 구체적이면
 *  그대로 신뢰하고, 비었거나 generic(application/octet-stream)일 때만 확장자로 보정한다.
 *  알려진 확장자가 아니면 기존 폴백(application/octet-stream)을 유지한다. */
function resolveContentType(file: { name: string; type: string }): string {
  const declared = file.type.trim();
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/** 엔진이 서버(워커 RPC)와 대화하는 표면. 앱 레이어가 apiClient 로 구현해 주입한다. */
export interface UploadBackend {
  create(input: CreateUploadInput): Promise<CreateUploadResult>;
  /** 재개용: 이미 올라간 파트 + 남은 파트 재서명 URL. */
  getParts(recordId: string): Promise<PartsResult>;
  /** 모든 파트 업로드 후 호출. 서버가 HEAD 검증까지 하고 첨부 메타를 돌려준다. */
  complete(recordId: string): Promise<CompletedUpload>;
  abort(recordId: string): Promise<void>;
}

export interface StartOptions {
  /** 진행 콜백. loaded/total 은 바이트. 전송 중에도 계속 갱신된다. */
  onProgress?: (loaded: number, total: number) => void;
  /** 동시 업로드 파트 수. 기본 3. */
  concurrency?: number;
  /** 파트 실패 시 재시도 횟수. 기본 3(지수 백오프). */
  maxRetries?: number;
  /**
   * 파트 PUT 하나당 타임아웃(ms). 기본 60_000. R2 로의 직접 PUT 에 fetch 자체 타임아웃이
   * 없어, 연결이 응답 없이 매달리면(예: CORS 미설정·네트워크 hang) 업로드가 영원히
   * "진행 중" 으로 남는다 — 이 타임아웃이 그 PUT 을 끊어 재시도 대상으로 만들고, 재시도까지
   * 소진되면 promise 를 reject 해 UI 가 무한 로딩 대신 오류를 표시하게 한다.
   */
  partTimeoutMs?: number;
}

export interface UploadHandle {
  /** 업로드 완료 시 첨부 메타로 resolve. 실패/취소 시 reject. */
  readonly promise: Promise<CompletedUpload>;
  /** 진행 중인 파트를 중단(완료된 파트는 서버에 남아 재개 가능). */
  pause(): void;
  /** pause 후 남은 파트부터 다시 시작. */
  resume(): void;
  /** 취소. 서버 abort 까지 호출하고 promise 를 reject 한다. */
  cancel(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type PutInput = {
  url: string;
  body: Blob;
  contentType: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** 지금까지 보낸 바이트. 재시도하면 0 부터 다시 센다. */
  onSent: (sent: number) => void;
};

/** XHR 로 한 번 PUT 한다. fetch 에는 보내는 쪽 진행률 API 가 없어 XHR 을 쓴다. */
function putOnce({ url, body, contentType, signal, timeoutMs, onSent }: PutInput): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.timeout = timeoutMs;
    xhr.upload.addEventListener("progress", (event) => onSent(event.loaded));
    xhr.addEventListener("load", () => {
      const isOk = xhr.status >= 200 && xhr.status < 300;
      if (isOk) resolve();
      else reject(new Error(`part PUT failed: ${xhr.status} ${xhr.statusText}`));
    });
    xhr.addEventListener("error", () => reject(new Error("part PUT failed: network error")));
    xhr.addEventListener("timeout", () => reject(new Error("part PUT failed: timeout")));
    xhr.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    xhr.addEventListener("loadend", () => signal.removeEventListener("abort", abort));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}

/** presigned URL 로 파트/파일 하나를 PUT 한다. 실패하면 지수 백오프로 재시도한다. */
async function putBlob(input: PutInput & { maxRetries: number }): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      input.onSent(0);
      await putOnce(input);
      return;
    } catch (err) {
      // 사용자가 중단(pause/cancel)한 경우만 재시도하지 않고 즉시 전파한다. 타임아웃은
      // 사용자 signal 과 무관하므로 재시도 경로로 흐른다.
      if (input.signal.aborted) throw err;
      attempt += 1;
      if (attempt > input.maxRetries) throw err;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
  }
}

/**
 * UploadBackend 를 받아 start/resume 를 제공하는 엔진을 만든다.
 * transport 는 표준 XHR/Blob 을 직접 쓴다(브라우저·electron 렌더러 공통). 네이티브
 * 백그라운드가 필요하면 이 파일을 대체하지 말고 putBlob 을 어댑터로 주입하도록 확장한다.
 */
/** 재개 입력 — 중단된 업로드의 recordId + 시작할 때와 같은 실행 옵션. */
export type ResumeInput = StartOptions & { recordId: string };

/** run 한 번의 실행 계약 — 실행 옵션과, 서버에서 업로드 계획을 받아오는 함수. */
type UploadJob = {
  opts: StartOptions;
  plan: () => Promise<{
    recordId: string;
    kind: "single" | "multipart";
    putUrl?: string;
    partSize?: number;
    partUrls: { partNumber: number; url: string }[];
    alreadyUploadedBytes: number;
  }>;
};

export function createUploadEngine(backend: UploadBackend) {
  /** 공통 실행부: create 결과(또는 재개 상태)를 받아 남은 파트를 올리고 complete 한다. */
  function run(file: File, job: UploadJob): UploadHandle {
    const { opts, plan } = job;
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    const maxRetries = opts.maxRetries ?? 3;
    const partTimeoutMs = opts.partTimeoutMs ?? 60_000;
    const total = file.size;
    // File.type 이 비는 파일(webm 등)을 확장자로 보정. create(정본 DB)와 R2 PUT 에
    // 같은 값을 써 일관성을 지킨다.
    const contentType = resolveContentType(file);

    let controller = new AbortController();
    let paused = false;
    let cancelled = false;
    let recordId: string | null = null;
    let resumeTrigger: (() => void) | null = null;

    const execute = async (): Promise<CompletedUpload> => {
      const p = await plan();
      recordId = p.recordId;
      // 파트 번호 → 보낸 바이트. 동시에 여러 파트가 올라가므로 합쳐서 알린다.
      const sentByPart = new Map<number, number>();
      const send = (partNumber: number) => (sent: number) => {
        sentByPart.set(partNumber, sent);
        let loaded = p.alreadyUploadedBytes;
        for (const n of sentByPart.values()) loaded += n;
        opts.onProgress?.(Math.min(loaded, total), total);
      };
      opts.onProgress?.(p.alreadyUploadedBytes, total);

      if (p.kind === "single") {
        if (!p.putUrl) throw new Error("single upload missing putUrl");
        await putBlob({
          url: p.putUrl,
          body: file,
          contentType,
          signal: controller.signal,
          maxRetries,
          timeoutMs: partTimeoutMs,
          onSent: send(1),
        });
      } else {
        // 멀티파트: 남은 파트를 제한된 동시성으로 올린다.
        const partSize = p.partSize ?? total;
        const queue = [...p.partUrls];
        const worker = async () => {
          for (;;) {
            if (cancelled) throw new DOMException("cancelled", "AbortError");
            // pause 상태면 resume 될 때까지 대기.
            if (paused) {
              await new Promise<void>((resolve) => {
                resumeTrigger = resolve;
              });
              continue;
            }
            const next = queue.shift();
            if (!next) return;
            const start = (next.partNumber - 1) * partSize;
            const end = Math.min(start + partSize, total);
            const chunk = file.slice(start, end);
            await putBlob({
              url: next.url,
              body: chunk,
              contentType,
              signal: controller.signal,
              maxRetries,
              timeoutMs: partTimeoutMs,
              onSent: send(next.partNumber),
            });
          }
        };
        const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, () =>
          worker(),
        );
        await Promise.all(workers);
      }

      return backend.complete(p.recordId);
    };

    const promise = execute();

    return {
      promise,
      pause() {
        paused = true;
        // 진행 중 요청을 끊는다(완료 파트는 서버에 남는다). 새 컨트롤러로 교체.
        controller.abort();
        controller = new AbortController();
      },
      resume() {
        if (!paused) return;
        paused = false;
        resumeTrigger?.();
        resumeTrigger = null;
      },
      async cancel() {
        cancelled = true;
        controller.abort();
        resumeTrigger?.();
        if (recordId) await backend.abort(recordId).catch(() => {});
      },
    };
  }

  return {
    /** 새 파일 업로드를 시작한다. */
    start(file: File, opts: StartOptions = {}): UploadHandle {
      const plan = async () => {
        const created = await backend.create({
          fileName: file.name,
          contentType: resolveContentType(file),
          size: file.size,
        });
        return {
          recordId: created.recordId,
          kind: created.kind,
          putUrl: created.putUrl,
          partSize: created.partSize,
          partUrls: created.partUrls ?? [],
          alreadyUploadedBytes: 0,
        };
      };
      return run(file, { opts, plan });
    },

    /** 중단됐던 업로드를 recordId + 같은 파일로 재개한다. 서버가 아는 파트는 건너뛴다. */
    resume(file: File, input: ResumeInput): UploadHandle {
      const { recordId, ...opts } = input;
      const plan = async () => {
        const parts = await backend.getParts(recordId);
        const alreadyUploadedBytes = parts.uploadedParts.length * parts.partSize;
        return {
          recordId,
          kind: "multipart" as const,
          partSize: parts.partSize,
          partUrls: parts.partUrls,
          alreadyUploadedBytes: Math.min(alreadyUploadedBytes, file.size),
        };
      };
      return run(file, { opts, plan });
    },
  };
}
