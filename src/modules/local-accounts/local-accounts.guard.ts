/**
 * Who may reach the local bank-accounts page. There is no login (Clerk's
 * production keys only work on their registered domain), so reachability is
 * the whole protection, and every check here must pass.
 */

/** Loopback socket addresses, including IPv4 carried over an IPv6 socket. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The address of the TCP peer, read from the socket. Never a forwarded
 * header: X-Forwarded-For is whatever the caller wrote.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

/**
 * The Host header names this machine on the API's own port. Blocks DNS
 * rebinding: a hostile page that resolves its own name to 127.0.0.1 still
 * sends its own name as Host.
 */
export function isLocalHostHeader(
  host: string | undefined,
  port: number,
): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  return value === `localhost:${port}` || value === `127.0.0.1:${port}`;
}

/**
 * Changes need a custom header the page sets. No CORS is configured, so a
 * browser won't let another site's script send it to this origin.
 */
export const LOCAL_MUTATION_HEADER = "X-Centsy-Local";

export function hasLocalMutationHeader(value: string | undefined): boolean {
  return value === "1";
}
