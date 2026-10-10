// The web app's only door to Calque: the server's REST API (the same tools as MCP).
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? `HTTP ${status}`));
    this.status = status;
    this.body = body;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = <T = Record<string, unknown>>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => parse<T>(r));

export const tool = <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => api<T>(`/api/tools/${name}`, args);

export const upload = <T = Record<string, unknown>>(path: string, form: FormData) =>
  fetch(path, { method: "POST", body: form }).then((r) => parse<T>(r));

/** An agent run, streamed: one callback per step, the result at the end. */
export async function agent<T>(path: string, body: unknown, onStep: (tools: string[]) => void): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) return parse<T>(res);
  let buf = "";
  let done: T | undefined;
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (line.step) onStep(line.step.tools);
      if (line.error) throw new ApiError(422, line.error);
      if (line.done) done = line.done;
    }
  }
  if (!done) throw new Error("the agent stopped without an answer");
  return done;
}

export interface Me {
  id: string;
  name?: string;
  teams: string[];
  admin: boolean;
  auth: boolean;
}

export interface Pack {
  id: string;
  name: string;
  version: string;
  default_language: string | null;
  languages: string[];
  visibility: "workspace" | "team";
  teams: string[];
  owner: string | null;
  /** The pack's current release (every publish, edit or restore adds one). */
  pack_version?: number;
  archived?: boolean;
  /** The caller manages it: its owner, or an admin. */
  editable: boolean;
}
