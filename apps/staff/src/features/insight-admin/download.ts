/**
 * Single-use export download (SCR-S-45; SPK-REPORT-007, §4.14 "expiring exports"). The API answers
 * `GET /v1/reports/exports/{id}/download` with the file itself (CSV or JSON) and needs the one-time
 * token in `X-Export-Token`; the typed JSON client sends neither custom headers nor reads text, so
 * this helper sends that one request with the same session, client identification and error
 * contract (§4.10) as the client. The token is held in memory by the screen only, never stored,
 * logged or put in a URL; the content is handed to the browser as a file and not kept.
 */
import {
  CLIENT_INFO_HEADER,
  CORRELATION_ID_HEADER,
  buildUrl,
  errorFromResponse,
  formatClientInfo,
  networkError,
  type ClientInfo,
  type FetchLike,
  type SessionStore,
} from '@sportspark/api-client';

export const EXPORT_TOKEN_HEADER = 'X-Export-Token';

export interface DownloadDeps {
  baseUrl: string;
  sessionStore: SessionStore;
  clientInfo: ClientInfo;
  fetch?: FetchLike;
}

export interface DownloadedFile {
  content: string;
  contentType: string;
  filename: string;
  correlationId: string | null;
}

/** `attachment; filename="report.csv"` to `report.csv`; only safe characters are kept. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  const raw = match?.[1] ?? fallback;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe : fallback;
}

export async function downloadExport(
  deps: DownloadDeps,
  exportId: string,
  token: string,
  fallbackName: string,
): Promise<DownloadedFile> {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = {
    Accept: 'text/csv, application/json',
    [CLIENT_INFO_HEADER]: formatClientInfo(deps.clientInfo),
    [EXPORT_TOKEN_HEADER]: token,
  };
  const session = await deps.sessionStore.load();
  if (session) headers.Authorization = `Bearer ${session.token}`;
  let response: Response;
  try {
    response = await fetchImpl(
      buildUrl(deps.baseUrl, '/reports/exports/{id}/download', { id: exportId }),
      { method: 'GET', headers },
    );
  } catch (cause) {
    throw networkError(cause);
  }
  const correlationId = response.headers.get(CORRELATION_ID_HEADER);
  const text = await response.text();
  if (!response.ok) {
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    throw errorFromResponse(response.status, body, correlationId);
  }
  return {
    content: text,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    filename: filenameFrom(response.headers.get('content-disposition'), fallbackName),
    correlationId,
  };
}

/** Hands a downloaded file to the browser; replaced in tests through `setFileSaver`. */
export type FileSaver = (file: DownloadedFile) => void;

const browserSaver: FileSaver = (file) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([file.content], { type: file.contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

let saver: FileSaver = browserSaver;

export function saveFile(file: DownloadedFile): void {
  saver(file);
}

/** Test seam: replace the browser save (returns a function that restores it). */
export function setFileSaver(next: FileSaver): () => void {
  const previous = saver;
  saver = next;
  return () => {
    saver = previous;
  };
}
