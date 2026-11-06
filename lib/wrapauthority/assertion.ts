import { randomUUID } from "node:crypto";
import { seal, open, UUID } from "./protocol";
import { integrationConfig } from "./integration-config";
export function issuePurchaseAssertion(userId: string, sessionId: string, now = Date.now()): string {
  const config = integrationConfig(), key = process.env.WA_PORTAL_ASSERTION_SECRET || "";
  if (!config || key.length < 32 || !UUID.test(userId) || !UUID.test(sessionId)) throw new Error("integration_unavailable");
  return seal({ sub: userId, sid: sessionId, iss: config.portalOrigin, aud: config.waOrigin,
    scope: "purchases:read", jti: randomUUID(), iat: now, exp: now + 30000 }, key, "wa-purchases");
}
export function verifyPurchaseAssertion(token: string, now = Date.now()) {
  const config = integrationConfig(), key = process.env.WA_PORTAL_ASSERTION_SECRET || "";
  if (!config) return null;
  const claims = open(token, key, "wa-purchases", now);
  if (!claims || claims.iss !== config.portalOrigin || claims.aud !== config.waOrigin ||
      claims.scope !== "purchases:read" || typeof claims.sub !== "string" || !UUID.test(claims.sub) ||
      typeof claims.sid !== "string" || !UUID.test(claims.sid) || typeof claims.jti !== "string" || !UUID.test(claims.jti) ||
      Number(claims.exp) - Number(claims.iat) !== 30000) return null;
  return { userId: claims.sub, sessionId: claims.sid };
}
