import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Secrets at rest (model API keys, Microsoft 365 refresh tokens): AES-256-GCM under a key derived
from CALQUE_SECRET, one key per `purpose` (none: the model keys' historical key). */
export function sealer(secret: string, purpose?: string) {
  const key = createHash("sha256")
    .update(purpose ? `${purpose}:${secret}` : secret)
    .digest();
  return {
    seal(text: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
    },
    open(sealed: string): string {
      const b = Buffer.from(sealed, "base64");
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
