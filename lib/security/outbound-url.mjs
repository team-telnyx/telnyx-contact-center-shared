import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function isBlockedIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true;
  }

  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  if (normalized === "::" || normalized === "::1") return true;

  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(firstHextet)) return true;

  // Only globally routable 2000::/3 addresses are allowed. Keep the
  // documentation prefix blocked even though it is inside that range.
  return (
    firstHextet < 0x2000 ||
    firstHextet > 0x3fff ||
    normalized.startsWith("2001:db8:") ||
    normalized === "2001:db8::"
  );
}

export function isBlockedOutboundAddress(address) {
  const version = isIP(String(address || "").split("%")[0]);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

export async function assertPublicHostname(hostname, { lookup = dnsLookup } = {}) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

  if (
    !normalized ||
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    throw new Error("Webhook hostname is not publicly routable");
  }

  const literalVersion = isIP(normalized);
  const addresses = literalVersion
    ? [{ address: normalized, family: literalVersion }]
    : await lookup(normalized, { all: true, verbatim: true });

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("Webhook hostname did not resolve");
  }

  if (addresses.some(({ address }) => isBlockedOutboundAddress(address))) {
    throw new Error("Webhook hostname resolves to a private or reserved address");
  }
}
