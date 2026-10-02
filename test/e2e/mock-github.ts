import { createServer, type Server } from "node:http";
import { createFakeGitHub, sampleRepo } from "../support/fake-github";

/**
 * A stand-in for api.github.com, for the workspace's browser tests: the same
 * fake the unit tests use (test/support/fake-github.ts), behind a port. The
 * dev server is pointed at it with GITHUB_API_URL; the app signs real JWTs and
 * asks for real narrowed tokens, and the fake answers like GitHub would.
 */

export const MOCK_GITHUB_PORT = 4011;
export const MOCK_GITHUB_URL = `http://127.0.0.1:${MOCK_GITHUB_PORT}`;
/** GitHub's id for the stand-in repository, 10xid-com/storefront. */
export const MOCK_REPOSITORY_ID = 4242;

export function startMockGitHub(): Promise<Server> {
  const fake = createFakeGitHub([sampleRepo({ id: MOCK_REPOSITORY_ID })]);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const answer = await fake.fetch(`${MOCK_GITHUB_URL}${req.url}`, { method: req.method, headers, body: raw || undefined });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(await answer.text());
    });
  });
  return new Promise((resolve) => server.listen(MOCK_GITHUB_PORT, "127.0.0.1", () => resolve(server)));
}
