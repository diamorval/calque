import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { resolve, type TokenTree } from "./dtcg.ts";

export interface Reconciliation {
  slot: string;
  template?: string;
  tokens?: string | null;
  reason: string;
}

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  default_language: string | null;
  missing_value: Record<string, string>;
  roles: Record<string, unknown>;
  grid: {
    margin_in: number;
    columns: Record<string, number[]>;
    title: { left_in: number; top_in: number; width_in: number; height_in: number; max_chars?: number };
    body_top_in: number;
    footer_top_in: number;
  };
  fonts: { files?: string[]; fallback: Record<string, string> };
  lint: { single_use_colors?: string[]; extra_colors?: string[] };
  reconciliation?: Reconciliation[];
}

export interface TemplateTheme {
  colors: Record<string, string>;
  fonts: Record<string, string>;
}

export interface DesignNotes {
  title?: string;
  atmosphere?: string;
  elements?: Record<string, string>;
  do?: string[];
  dont?: string[];
  agent?: string[];
}

export interface PackData {
  dir: string;
  manifest: PackManifest;
  tokens: TokenTree;
  values: Map<string, unknown>;
  canvas: { width_in: number; height_in: number };
  theme: TemplateTheme;
  notes: DesignNotes;
}

const readYaml = <T>(path: string): T => parse(readFileSync(path, "utf8")) as T;

/** Light read of a pack for design purposes. Full validation is the engine's `validate-pack`. */
export function readPack(dir: string): PackData {
  const manifest = readYaml<PackManifest>(join(dir, "pack.yaml"));
  const tokens = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")) as TokenTree;
  const map = readYaml<{ canvas: PackData["canvas"]; theme: TemplateTheme }>(join(dir, "template-map.yaml"));
  const notesPath = join(dir, "design-notes.yaml");
  const notes = existsSync(notesPath) ? readYaml<DesignNotes>(notesPath) : {};
  return { dir, manifest, tokens, values: resolve(tokens), canvas: map.canvas, theme: map.theme, notes };
}
