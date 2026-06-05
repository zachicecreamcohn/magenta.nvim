import { networkInterfaces } from "node:os";

// Picks a host address that's reachable from other devices. Prefers a
// Tailscale address (100.x.y.z, the CGNAT range Tailscale uses) so the web UI
// is reachable over the tailnet; otherwise falls back to the first non-internal
// IPv4 address (LAN), and finally to "localhost" if nothing else is found.
export function detectReachableHost(): string {
  const interfaces = networkInterfaces();
  let lanFallback: string | undefined;

  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("100.")) {
        return addr.address;
      }
      if (lanFallback === undefined) {
        lanFallback = addr.address;
      }
    }
  }

  return lanFallback ?? "localhost";
}
