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

let packDirs: () => Promise<Record<string, string>> = async () => ({});

/** Where every pack's current release lives (id -> directory), sent with each call so the engine
resolves a pack's `extends` (group -> subsidiary). Set once by createApp. */
// ponytail: one app per process; a second createApp (tests) takes over the lookup.
export function lookupPacks(fn: () => Promise<Record<string, string>>) {
  packDirs = fn;
}

/** One engine call: JSON request on stdin, JSON response on stdout (`calque_engine.api`). */
// ponytail: one Python process per call (~0.3 s start-up); a long-lived worker if latency matters.
export async function engine<T = Record<string, unknown>>(op: string, args: Record<string, unknown>): Promise<T> {
  const packs = "pack" in args ? await packDirs() : undefined;
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
        // the traceback stays in the server log; the caller only learns that the engine failed
        console.error(`engine ${op} crashed:\n${err.trim() || out.trim() || "no output"}`);
        return reject(new EngineError("engine_crash", `the engine failed on ${op}; details are in the server log`));
      }
      if (!res.ok) return reject(new EngineError(res.error ?? "engine", res.message ?? "", res.issues));
      resolve(res);
    });
    child.stdin.end(JSON.stringify({ op, ...args, ...(packs ? { packs } : {}) }));
  });
}
