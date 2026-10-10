import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Egress policy for model endpoints (SSRF): the server fetches every model's base URL itself, so an
admin could point one at the cloud metadata service or an internal host. */

/** Link-local and cloud metadata addresses: refused unless CALQUE_MODEL_HOSTS names them exactly. */
const METADATA = new BlockList();
METADATA.addSubnet("169.254.0.0", 16, "ipv4"); // link-local: AWS, GCP, Azure, OpenStack metadata
METADATA.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata
METADATA.addSubnet("fe80::", 10, "ipv6"); // link-local
METADATA.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata over IPv6

export const isMetadata = (ip: string) => {
  const v = isIP(ip);
  return v !== 0 && METADATA.check(ip, v === 6 ? "ipv6" : "ipv4"); // IPv4-mapped IPv6 included
};

/** CALQUE_MODEL_HOSTS: comma-separated hosts; `.example.com` (or `*.example.com`) allows its subdomains. */
export const allowedHosts = (env = process.env.CALQUE_MODEL_HOSTS) =>
  (env ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\*\./, ".").replace(/^\[|\]$/g, ""))
    .filter(Boolean);

const addresses = (host: string) => lookup(host, { all: true }).then((a) => a.map((x) => x.address));
const matches = (host: string, entry: string) => (entry.startsWith(".") ? host.endsWith(entry) : host === entry);

/** Throws unless the server may call `url`: http(s), on the allow-list when there is one, never a
metadata address (literal or resolved) unless listed exactly. */
export async function checkEndpoint(url: string, allow = allowedHosts(), resolve = addresses): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid base URL ${JSON.stringify(url)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`base URL must be http or https, not ${u.protocol}`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allow.length && !allow.some((e) => matches(host, e))) {
    throw new Error(`model host ${host} is not allowed (CALQUE_MODEL_HOSTS)`);
  }
  if (allow.includes(host)) return; // named exactly: trusted as is
  // an unresolvable host fails later, at the call
  const ips = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (ips.some(isMetadata)) throw new Error(`model host ${host} is a link-local or metadata address`);
}
