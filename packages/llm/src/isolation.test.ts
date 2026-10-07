import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SDK = /^(ai|ai\/.*|@ai-sdk\/.*|openai|@anthropic-ai\/.*|@google\/genai|@google\/generative-ai|@mistralai\/.*|ollama|@langchain\/.*|langchain)$/;
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".turbo", ".data"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(m?[jt]sx?|json)$/.test(e.name)) yield p;
  }
}

it("no package but @calque/llm imports or depends on a model provider SDK", () => {
  const offenders: string[] = [];
  for (const root of ["apps", "packages", "scripts"]) {
    for (const f of files(join(REPO, root))) {
      if (f.startsWith(join(REPO, "packages/llm/"))) continue;
      const src = readFileSync(f, "utf8");
      const specs = f.endsWith("package.json")
        ? Object.keys({ ...JSON.parse(src).dependencies, ...JSON.parse(src).devDependencies })
        : [...src.matchAll(IMPORT)].map((m) => m[1] as string);
      for (const s of specs) if (SDK.test(s)) offenders.push(`${relative(REPO, f)}: ${s}`);
    }
  }
  expect(offenders).toEqual([]);
});
