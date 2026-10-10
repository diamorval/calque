// The GitHub Pages demo's data: the real server and engine build the Diametral golden decks, then
// every response the web app reads is saved as a static file (demo/out). src/demo.ts replays them.
// Usage: node demo/snapshot.ts (from apps/web; needs the engine's uv env, LibreOffice, pdftoppm).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../../server/src/app.ts";
import { createHttp } from "../../server/src/http.ts";

/** Stands for the site's base URL in the saved JSON; src/demo.ts swaps it at load. */
export const ORIGIN = "https://calque.demo";
const REPO = join(import.meta.dirname, "../../..");
const OUT = join(import.meta.dirname, "out");
const DECKS = ["exemplar-acts", "archetypes-fr", "data-fr"];

rmSync(OUT, { recursive: true, force: true });
const app = await createApp({
  data: mkdtempSync(join(tmpdir(), "calque-demo-")),
  db: "memory://",
  publicUrl: ORIGIN,
});
const http = createHttp(app);
const api: Record<string, unknown> = {};

async function call(method: string, path: string, body?: unknown) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await http.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: json ?? null,
  });
  if (!res.ok)
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  api[`${method} ${path}${json ? ` ${json}` : ""}`] = data;
  return data;
}

async function save(url: string) {
  const path = new URL(url, ORIGIN).pathname;
  const res = await http.request(path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  const file = join(OUT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

for (const name of DECKS) {
  const deck = JSON.parse(
    readFileSync(
      join(REPO, `packs/diametral/tests/golden/${name}.json`),
      "utf8",
    ),
  );
  const { deck_id } = await call("POST", "/api/tools/create_deck", { deck });
  if (name === DECKS[0]) {
    // a history and open comments, so the History dialog and the Comments tab have something to show
    await call("POST", "/api/tools/patch_deck", {
      deck_id,
      ops: [
        {
          op: "set_field",
          slide: "cover",
          field: "message",
          value: "One promise to the reader, in one line",
        },
      ],
      note: "Sharpen the cover message",
    });
    await call("POST", "/api/tools/add_comment", {
      deck_id,
      slide_id: "footprint",
      shape_id: 3,
      text: "Cite the source of this figure",
    });
    await call("POST", "/api/tools/add_comment", {
      deck_id,
      slide_id: "conviction",
      text: "One idea per slide: split this one",
    });
  }
  const opened = await call("POST", "/api/tools/open_deck", { deck_id });
  await call("POST", "/api/tools/lint_deck", { deck_id });
  const { download_url } = await call("POST", "/api/tools/export_pptx", {
    deck_id,
  });
  const pdf = await call("POST", "/api/tools/export_pdf", { deck_id });
  for (const s of opened.slides) await save(s.image_url);
  await save(download_url);
  await save(pdf.download_url);
  console.log(`${name}: ${opened.slides.length} slides`);
}
await call("GET", "/api/decks");
await call("POST", "/api/tools/list_packs", {});
await call("GET", "/api/models");
// Brand packs > Edit: the review screen on the pack's template, its slide images saved too
const draft = (await call("POST", "/api/packs/diametral/edit", {})) as {
  slides: { image_url: string }[];
};
for (const s of draft.slides) {
  await save(s.image_url);
  s.image_url = ORIGIN + s.image_url;
}
const me = (await call("GET", "/api/me")) as Record<string, unknown>;
api["GET /api/me"] = { ...me, name: "Demo" };

const replayed = Object.entries(api).filter(
  ([k]) => !/^POST \/api\/tools\/(create_deck|patch_deck|add_comment) /.test(k),
);
writeFileSync(
  join(OUT, "api.json"),
  JSON.stringify(Object.fromEntries(replayed)),
);
console.log(`${replayed.length} responses in ${OUT}`);
process.exit(0);
