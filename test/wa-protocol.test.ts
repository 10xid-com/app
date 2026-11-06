import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationConfig, waDatabaseAllowed } from "../lib/wrapauthority/integration-config";
import { open, seal, freshMfa } from "../lib/wrapauthority/protocol";
import { issuePurchaseAssertion, verifyPurchaseAssertion } from "../lib/wrapauthority/assertion";
const key = "k".repeat(48), now = 1800000000000;
const user = "10000000-0000-4000-8000-000000000001", session = "20000000-0000-4000-8000-000000000001";
const staging = { WA_INTEGRATION_ENV: "staging", WA_STAGING_ORIGIN: "https://staging-wa.example.test",
  WA_STAGING_LOGIN_ORIGIN: "https://staging-login.example.test", WA_STAGING_PORTAL_ORIGIN: "https://staging-portal.example.test" };
beforeEach(() => { for (const [name,value] of Object.entries(staging)) vi.stubEnv(name,value); vi.stubEnv("WA_PORTAL_ASSERTION_SECRET",key); });
afterEach(() => vi.unstubAllEnvs());
describe("WA isolated integration protocol", () => {
  it("is disabled without an explicit environment and has fixed production origins", () => {
    expect(integrationConfig({})).toBeNull();
    expect(integrationConfig({ WA_INTEGRATION_ENV: "production" })?.waOrigin).toBe("https://wrapauthority.net");
  });
  it("requires three exact HTTPS staging origins and the approved staging database", () => {
    const config=integrationConfig(staging)!; expect(config).not.toBeNull();
    expect(waDatabaseAllowed("https://ehejnxhznfnxoetnnhxg.supabase.co",config)).toBe(true);
    expect(waDatabaseAllowed("https://mthhbumyytiblttjrjig.supabase.co",config)).toBe(false);
    for (const value of ["http://staging.example.test","https://user:password@staging.example.test","https://staging.example.test:8443","https://staging.example.test/path","https://staging.example.test?x=y","https://wrapauthority.net","https://example.test"]) {
      expect(integrationConfig({...staging,WA_STAGING_ORIGIN:value})).toBeNull();
    }
    expect(integrationConfig({...staging,WA_STAGING_ORIGIN:staging.WA_STAGING_LOGIN_ORIGIN})).toBeNull();
  });
  it("rejects altered, expired, future, wrong-purpose and overlong signed envelopes", () => {
    const body={iat:now,exp:now+30000}; const token=seal(body,key,"a");
    expect(open(token,key,"a",now)).toMatchObject(body);
    expect(open(token+"x",key,"a",now)).toBeNull();
    expect(open(token,key,"b",now)).toBeNull();
    expect(open(token,key,"a",now+30000)).toBeNull();
    expect(open(token,key,"a",now-1)).toBeNull();
    expect(open(seal({iat:now,exp:now+300001},key,"a"),key,"a",now)).toBeNull();
  });
  it("pins purchase assertions to their audience, issuer, scope and 30-second lifetime", () => {
    const token=issuePurchaseAssertion(user,session,now);
    expect(verifyPurchaseAssertion(token,now)).toEqual({userId:user,sessionId:session});
    expect(verifyPurchaseAssertion(token,now+30000)).toBeNull();
    for (const changed of [{aud:"https://evil.test"},{iss:"https://evil.test"},{scope:"artwork:write"},{sub:"invalid"},{sid:"invalid"},{exp:now+30001}]) {
      const payload={sub:user,sid:session,jti:user,iss:staging.WA_STAGING_PORTAL_ORIGIN,aud:staging.WA_STAGING_ORIGIN,scope:"purchases:read",iat:now,exp:now+30000,...changed};
      expect(verifyPurchaseAssertion(seal(payload,key,"wa-purchases"),now)).toBeNull();
    }
  });
  it("requires an authenticator timestamp within five minutes and rejects future/invalid dates", () => {
    expect(freshMfa(new Date(now),now)).toBe(true);
    expect(freshMfa(new Date(now-300001),now)).toBe(false);
    expect(freshMfa(new Date(now+1),now)).toBe(false);
    expect(freshMfa(new Date("invalid"),now)).toBe(false);
    expect(freshMfa(null,now)).toBe(false);
  });
});
