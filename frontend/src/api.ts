export type Metrics = {
  received: number;
  indexed: number;
  rejected: number;
  errors: number;
  received_rate: number;
  indexed_rate: number;
  queue_depth: number;
  indexing_lag: number;
  active_workers: number;
  workers: string[];
  worker_paused: Record<string, boolean>;
  avg_processing_ms: number;
  generator: { status: string; rate: number };
  workers_paused: boolean;
  worker_delay_ms: number;
  timestamp: number;
};
export type Log = {
  event_id: string;
  timestamp: string;
  service: string;
  host: string;
  severity: string;
  message: string;
  trace_id: string | null;
  metadata: Record<string, unknown>;
  received_at: string;
  indexed_at: string;
};
export type Service = {
  service: string;
  volume: number;
  errors: number;
  last_seen: string;
};
export type Stats = {
  stored: number;
  active_services: number;
  error_logs: number;
  series: { minute: string; indexed: number }[];
};
const base = "/api";
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(base + path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options?.headers,
    },
  });
  if (response.status === 401 && path !== "/session") {
    window.location.reload();
    throw new Error("Simulation expired. Starting a new one.");
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail =
        typeof body.detail === "string"
          ? body.detail
          : JSON.stringify(body.detail);
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const qs = (
  values: Record<string, string | number | undefined | null>,
) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== "")
      q.set(key, String(value));
  return q.toString();
};
