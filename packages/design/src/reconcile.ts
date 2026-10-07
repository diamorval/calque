import { family, hex6 } from "./dtcg.ts";
import type { PackData } from "./pack.ts";

export interface Gap {
  slot: string;
  template: string | null;
  tokens: string | null;
  arbitrated: string | null; // the reason, when pack.yaml accepts this gap
}

/** Compare the template theme (extracted) with the `theme.*` tokens. */
export function reconcile(pack: PackData): Gap[] {
  const pairs: [string, string | null, string | null][] = [];
  const tokenColor = (slot: string) => {
    const v = pack.values.get(`theme.${slot}`);
    return v === undefined ? null : hex6(v);
  };
  const slots = new Set([
    ...Object.keys(pack.theme.colors),
    ...[...pack.values.keys()].filter((k) => /^theme\.[^.]+$/.test(k)).map((k) => k.slice(6)),
  ]);
  for (const slot of slots) {
    const t = pack.theme.colors[slot];
    pairs.push([slot, t ? hex6(t) : null, tokenColor(slot)]);
  }
  for (const slot of ["major", "minor"]) {
    const v = pack.values.get(`theme.font.${slot}`);
    pairs.push([`font.${slot}`, pack.theme.fonts[slot] ?? null, v === undefined ? null : family(v)]);
  }
  const accepted = pack.manifest.reconciliation ?? [];
  return pairs
    .filter(([, t, k]) => t !== k)
    .map(([slot, template, tokens]) => {
      const a = accepted.find(
        (r) => r.slot === slot && (r.template === undefined || r.template.toUpperCase() === template?.toUpperCase()),
      );
      return { slot, template, tokens, arbitrated: a?.reason ?? null };
    });
}
