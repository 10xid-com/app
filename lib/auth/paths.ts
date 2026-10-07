/**
 * Where a "where were you going" value may lead: a local path, and nothing
 * else.
 *
 * Revision 2: "Accept only validated local post-login return paths." A value
 * that is not plainly a path on this host is discarded for "/". `//evil.test`
 * is the case a naive "starts with a slash" check waves straight through, and
 * it is a fully qualified URL to a browser; a backslash is turned into a slash
 * by some browsers, which makes `/\evil.test` the same thing.
 *
 * Pure, with no `server-only`, so the proxy and the tests can use it.
 */
export function safePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  if (!input.startsWith("/")) return "/";
  if (input.startsWith("//")) return "/";
  if (input.includes("\\")) return "/";
  if (/[\p{Cc}]/u.test(input)) return "/";
  return input;
}
