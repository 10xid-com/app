import { afterEach, describe, expect, test } from "vitest";
import { driveConfig, driveIsConfigured } from "@/lib/integrations/google-drive";

/**
 * Reading the Google service account out of the environment.
 *
 * Worth its own tests because this is the part a person configures by hand,
 * under time pressure, by pasting something out of a downloaded file. Every
 * way of getting it slightly wrong should leave the integration inert rather
 * than half-working — a folder half-created in somebody's Drive is a worse
 * outcome than a button that says it is not connected.
 */

const ORIGINAL = { ...process.env };

// Not a real key: generated for this test and valid nowhere.
const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
  "-----END PRIVATE KEY-----",
].join("\n");

function clear() {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("with nothing configured", () => {
  test("it is inert, and says so", () => {
    clear();
    expect(driveConfig()).toBeNull();
    expect(driveIsConfigured()).toBe(false);
  });
});

describe("the whole JSON file pasted in", () => {
  test("is accepted, and the address is read out of it", () => {
    clear();
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      type: "service_account",
      project_id: "example",
      client_email: "portal@example.iam.gserviceaccount.com",
      private_key: PEM.replace(/\n/g, "\\n"),
    });
    process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = "folder-123";

    const config = driveConfig();
    expect(config).not.toBeNull();
    expect(config!.clientEmail).toBe("portal@example.iam.gserviceaccount.com");
    // The escaped newlines are real newlines by the time they reach the signer,
    // which is what a PEM parser requires.
    expect(config!.privateKey).toContain("\n");
    expect(config!.privateKey.startsWith("-----BEGIN")).toBe(true);
  });

  test("a truncated paste is refused rather than half-read", () => {
    clear();
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY =
      '{"client_email":"portal@example.iam.gserviceaccount.com","private_ke';
    process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = "folder-123";
    expect(driveConfig()).toBeNull();
  });
});

describe("just the private key, with the address set separately", () => {
  test("is accepted", () => {
    clear();
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL =
      "portal@example.iam.gserviceaccount.com";
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = PEM;
    process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = "folder-123";

    const config = driveConfig();
    expect(config!.clientEmail).toBe("portal@example.iam.gserviceaccount.com");
    expect(config!.privateKey).toBe(PEM);
  });

  test("without the address it stays inert", () => {
    clear();
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = PEM;
    process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = "folder-123";
    expect(driveConfig()).toBeNull();
  });

  test("something that is not a key at all stays inert", () => {
    clear();
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL =
      "portal@example.iam.gserviceaccount.com";
    // The mistake this catches: pasting the service account's client ID, or an
    // API key, where the private key belongs.
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "AIzaSyExampleLooksLikeAKey";
    process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID = "folder-123";
    expect(driveConfig()).toBeNull();
  });
});

describe("the parent folder", () => {
  test("is required — there is no default place to write", () => {
    clear();
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL =
      "portal@example.iam.gserviceaccount.com";
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = PEM;
    expect(driveConfig()).toBeNull();
  });
});
