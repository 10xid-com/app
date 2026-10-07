/**
 * For Railway's healthcheck: 200 once the server has started.
 *
 * It says nothing else, and that is the point of it. Startup refuses to
 * complete when the host settings are missing or the
 * database role is privileged (instrumentation.ts); every request then fails,
 * this one included, so a deployment configured with this path as its
 * healthcheck is stopped instead of going live. The proxy lets it through on
 * any host, because Railway's checker does not send app.10xid.com.
 */
export function GET() {
  return new Response("ok", { headers: { "cache-control": "no-store" } });
}
