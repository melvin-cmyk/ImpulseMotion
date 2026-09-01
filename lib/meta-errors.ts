/**
 * Typed Meta Graph API errors + retry classification.
 *
 * Meta returns errors as `{ error: { code, error_subcode, message, fbtrace_id } }`
 * with an HTTP status that is NOT reliable for classification (rate limits
 * come back as HTTP 400 with code 4/17/32/613). The mapping below is the
 * single source of truth for "is this retryable?" used by `metaFetch`.
 *
 * Docs: https://developers.facebook.com/docs/graph-api/guides/error-handling
 *       https://developers.facebook.com/docs/marketing-api/error-reference
 */

export type MetaErrorKind =
  | "rate_limit"
  | "auth"
  | "permission"
  | "invalid"
  | "transient"
  | "unknown";

export interface MetaErrorClassification {
  kind: MetaErrorKind;
  retryable: boolean;
}

/**
 * Pure mapping (code, subcode, httpStatus) → kind/retryable.
 * - 4, 17, 32, 613, 80000-80008 → rate_limit (retryable)
 * - 2 → transient (retryable: "service temporarily unavailable")
 * - 190, 102 → auth (not retryable)
 * - 10, 100+subcode 33, 200-299 → permission (not retryable)
 * - 100 (other subcodes) → invalid (not retryable)
 * - HTTP 429 → rate_limit, HTTP 5xx / no code (network) → transient (retryable)
 */
export function classifyMetaError(input: {
  code?: number | null;
  subcode?: number | null;
  httpStatus?: number | null;
}): MetaErrorClassification {
  const code = typeof input.code === "number" ? input.code : undefined;
  const subcode = typeof input.subcode === "number" ? input.subcode : undefined;
  const status = typeof input.httpStatus === "number" ? input.httpStatus : 0;

  if (code !== undefined) {
    if (code === 4 || code === 17 || code === 32 || code === 613 || (code >= 80000 && code <= 80008)) {
      return { kind: "rate_limit", retryable: true };
    }
    if (code === 2) return { kind: "transient", retryable: true };
    if (code === 190 || code === 102) return { kind: "auth", retryable: false };
    if (code === 10 || (code >= 200 && code <= 299)) return { kind: "permission", retryable: false };
    if (code === 100) {
      return subcode === 33
        ? { kind: "permission", retryable: false }
        : { kind: "invalid", retryable: false };
    }
    if (code === 1) return { kind: "transient", retryable: true }; // "An unknown error occurred" — Meta says retry
  }

  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status >= 500) return { kind: "transient", retryable: true };
  if (status === 0) return { kind: "transient", retryable: true }; // network / abort
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 400 && code === undefined) return { kind: "invalid", retryable: false };
  return { kind: "unknown", retryable: false };
}

export class MetaApiError extends Error {
  readonly name = "MetaApiError";
  code: number;
  subcode?: number;
  httpStatus: number;
  retryable: boolean;
  kind: MetaErrorKind;
  fbtraceId?: string;
  /** Graph path that failed (no token), for logs */
  path?: string;

  constructor(opts: {
    message: string;
    code?: number | null;
    subcode?: number | null;
    httpStatus: number;
    fbtraceId?: string;
    path?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.code = typeof opts.code === "number" ? opts.code : 0;
    this.subcode = typeof opts.subcode === "number" ? opts.subcode : undefined;
    this.httpStatus = opts.httpStatus;
    this.fbtraceId = opts.fbtraceId;
    this.path = opts.path;
    const cls = classifyMetaError({ code: this.code || undefined, subcode: this.subcode, httpStatus: this.httpStatus });
    this.kind = cls.kind;
    this.retryable = cls.retryable;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  /** Short, log-friendly description: "[rate_limit] code=4 http=400 msg" */
  describe(): string {
    return `[${this.kind}] code=${this.code}${this.subcode ? `/${this.subcode}` : ""} http=${this.httpStatus}${
      this.fbtraceId ? ` trace=${this.fbtraceId}` : ""
    }: ${this.message}`;
  }
}

export function isMetaApiError(err: unknown): err is MetaApiError {
  return err instanceof MetaApiError || (!!err && typeof err === "object" && (err as { name?: string }).name === "MetaApiError");
}

/**
 * "No data" is NEVER an error from the Graph API (it returns `data: []`), so a
 * thrown error must not be interpreted as "no data". This helper exists to
 * make that explicit at call sites: it always returns false for errors and
 * true only for an actual empty payload.
 */
export function isMetaNoData(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (Array.isArray(payload)) return payload.length === 0;
  if (typeof payload === "object") {
    const p = payload as { data?: unknown; hasData?: boolean };
    if (p.hasData === false) return true;
    if (Array.isArray(p.data)) return p.data.length === 0;
  }
  return false;
}
