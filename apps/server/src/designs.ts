// The design medium of the document store (decks.ts): DesignSpec documents (social posts, ads,
// banners, posters, web sections) live in `decks` with medium = 'design', and share everything a
// deck has (versions, sharing and links, comments, approval, chat, audit). What differs is here:
// the engine lays them out (headless Chromium), lints and exports them, and their images.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeckSpec, DesignSpec } from "@calque/deckspec";
import { engine } from "./engine.ts";
import { FILE_REF } from "./files.ts";

export const OUTPUTS = ["png", "pdf", "svg", "html"] as const;
export type Output = (typeof OUTPUTS)[number];
export const CODE_TARGETS = ["html", "react", "tailwind"] as const;
export type Medium = "deck" | "design";

export interface DesignFinding {
  severity: "ERROR" | "WARN";
  artboard: string;
  node: string | null;
  check: string;
  message: string;
}

export interface RenderedArtboard {
  id: string;
  format: string;
  width: number;
  height: number;
  mode: string | null;
  files: Partial<Record<Output, string>>;
  boxes: Record<string, { x: number; y: number; w: number; h: number }>;
}

export interface DesignRender {
  artboards: RenderedArtboard[];
  /** the whole design as one PDF (one page per artboard), when pdf was asked for */
  pdf?: string;
  findings: DesignFinding[];
  warnings: { severity: string; artboard: string | null; node: string | null; message: string }[];
}

export const isDesign = (spec: DeckSpec | DesignSpec): spec is DesignSpec => "artboards" in spec;

type AnyNode = { type?: string; src?: string; component?: string; children?: AnyNode[] };

/** `spec` with every `file:<id>` image (artboards and components) rewritten by `fn` (id -> id). */
export function mapDesignRefs(spec: DesignSpec, fn: (id: string) => string): DesignSpec {
  const walk = (n: AnyNode): AnyNode => ({
    ...n,
    ...(n.type === "image" && n.src?.startsWith(FILE_REF) ? { src: `${FILE_REF}${fn(n.src.slice(FILE_REF.length))}` } : {}),
    ...(n.children ? { children: n.children.map(walk) } : {}),
  });
  const node = <T,>(n: T): T => walk(n as AnyNode) as T;
  const comps = spec.components;
  return {
    ...spec,
    artboards: spec.artboards.map((b) => ({ ...b, children: b.children.map(node) })),
    ...(comps
      ? {
          components: Object.fromEntries(
            Object.entries(comps).map(([k, c]) => [
              k,
              { ...c, node: node(c.node), ...(c.variants ? { variants: Object.fromEntries(Object.entries(c.variants).map(([v, n]) => [v, node(n)])) } : {}) },
            ]),
          ),
        }
      : {}),
  };
}

/** Lay `spec` out into `dir` (replaced as a whole): the PNGs and the other `outputs` at `scale`,
the node boxes, the lint; `render.json` keeps the result next to the files. */
export async function renderDesign(data: string, packDir: string, spec: DesignSpec, dir: string, outputs: readonly Output[], scale: number): Promise<DesignRender> {
  const tmp = `${dir}.tmp-${randomUUID()}`;
  await mkdir(tmp, { recursive: true });
  try {
    const r = await engine<DesignRender>("design_render", {
      pack: packDir,
      design: spec,
      out_dir: tmp,
      outputs: [...new Set<Output>(["png", ...outputs])],
      scale,
      image_roots: [packDir],
      file_root: join(data, "uploads"),
    });
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    // the files moved with the folder: point at their final place
    const moved = (f: string) => join(dir, f.split(/[\\/]/).pop() as string);
    const out: DesignRender = {
      artboards: r.artboards.map((a) => ({ ...a, files: Object.fromEntries(Object.entries(a.files).map(([k, f]) => [k, moved(f)])) })),
      ...(r.pdf ? { pdf: moved(r.pdf) } : {}),
      findings: r.findings,
      warnings: r.warnings,
    };
    await writeFile(join(dir, "render.json"), JSON.stringify(out));
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Artboards `ids` of `src` for design `into`, with the components they use (and those
components use); ids taken in `into` get a `-copy` suffix. */
export function pickArtboards(src: DesignSpec, ids: string[], into: DesignSpec) {
  const taken = new Set(into.artboards.map((b) => b.id));
  const renamed: Record<string, string> = {};
  const used = new Set<string>();
  const collect = (n: AnyNode) => {
    if (n.type === "instance" && n.component && !used.has(n.component)) {
      used.add(n.component);
      const c = src.components?.[n.component];
      if (c) [c.node, ...Object.values(c.variants ?? {})].forEach((x) => collect(x as AnyNode));
    }
    n.children?.forEach(collect);
  };
  const artboards = ids.map((aid) => {
    const b = src.artboards.find((x) => x.id === aid);
    if (!b) throw new Error(`no artboard ${JSON.stringify(aid)} in "${src.title}"`);
    b.children.forEach((n) => collect(n as AnyNode));
    let nid = b.id;
    for (let k = 1; taken.has(nid); k++) nid = `${b.id}-copy${k > 1 ? k : ""}`;
    taken.add(nid);
    renamed[b.id] = nid;
    return { ...structuredClone(b), id: nid };
  });
  const components: NonNullable<DesignSpec["components"]> = {};
  for (const k of used) {
    const c = src.components?.[k];
    if (c) components[k] = structuredClone(c);
  }
  return { artboards, components, renamed };
}

/** The text a design carries (search): its title and every string in its artboards. */
export function designStrings(spec: DesignSpec): string[] {
  const out = [spec.title];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(spec.artboards);
  return out;
}
