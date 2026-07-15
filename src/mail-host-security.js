import { isIP } from "node:net";

export function unsafeMailHost(value) {
  const host = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true;
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || octets[0] >= 224;
  }
  if (family === 6) {
    return host === "::" || host === "::1" || host.startsWith("fe8") || host.startsWith("fe9")
      || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("ff")
      || host.startsWith("::ffff:127.") || host.startsWith("::ffff:169.254.");
  }
  return false;
}

export function assertSafeMailChannel(channel) {
  if (unsafeMailHost(channel?.inbound_host) || unsafeMailHost(channel?.outbound_host)) {
    throw new Error("Lokale, Link-Local- und Metadaten-Adressen sind als Mailserver nicht zulässig.");
  }
}
