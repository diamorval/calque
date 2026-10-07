import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export class EngineError extends Error {
  readonly kind: string;
  readonly issues: unknown;
  constructor(kind: string, message: string, issues?: unknown) {
    super(message);
    this.kind = kind;
    this.issues = issues;
  }
}

// CALQUE_ENGINE overrides the command, e.g. "python -m calque_engine call" in the server image.
const [CMD, ...ARGS] = process.env.CALQUE_ENGINE?.split(" ") ?? [
  "uv",
  "run",
  "--project",
  `${REPO}engine`,
  "--quiet",
  "python",
  "-m",
  "calque_engine",
  "call",
];

/** One engine call: JSON request on stdin, JSON response on stdout (`calque_engine.api`). */
// ponytail: one Python process per call (~0.3 s start-up); a long-lived worker if latency matters.
export function engine<T = Record<string, unknown>>(op: string, args: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(CMD as string, ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      let res: { ok: boolean; error?: string; message?: string; issues?: unknown } & T;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new EngineError("engine_crash", err.trim() || out.trim() || "no output"));
      }
      if (!res.ok) return reject(new EngineError(res.error ?? "engine", res.message ?? "", res.issues));
      resolve(res);
    });
    child.stdin.end(JSON.stringify({ op, ...args }));
  });
}
