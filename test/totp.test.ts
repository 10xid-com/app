import { describe, expect, test } from "vitest";
import {
  base32Decode,
  base32Encode,
  currentCode,
  decryptSecret,
  encryptSecret,
  generateSecret,
  verifyCode,
} from "@/lib/auth/totp";

/**
 * Checked against RFC 6238's own published test vectors.
 *
 * This is a hand-written implementation of a specified algorithm, so "it seems
 * to work with my phone" is not evidence — a subtly wrong one still produces
 * six plausible digits, and would only reveal itself as intermittent sign-in
 * failures once staff depended on it.
 */

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII string below.
const RFC_SEED = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("RFC 6238 test vectors", () => {
  // The RFC publishes 8-digit codes; a 6-digit code is its last six digits.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  for (const [unixSeconds, expected] of vectors) {
    test(`T=${unixSeconds} produces ${expected}`, () => {
      expect(currentCode(RFC_SEED, unixSeconds * 1000)).toBe(expected);
    });
  }
});

describe("base32", () => {
  test("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255, 42, 17]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  test("uses only the standard alphabet", () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]+$/);
  });
});

describe("verification", () => {
  const at = 1_700_000_000_000;

  test("accepts the current code", () => {
    expect(verifyCode(RFC_SEED, currentCode(RFC_SEED, at), at)).toBe(true);
  });

  test("accepts one step of drift either way", () => {
    expect(verifyCode(RFC_SEED, currentCode(RFC_SEED, at - 30_000), at)).toBe(true);
    expect(verifyCode(RFC_SEED, currentCode(RFC_SEED, at + 30_000), at)).toBe(true);
  });

  test("refuses two steps of drift", () => {
    expect(verifyCode(RFC_SEED, currentCode(RFC_SEED, at - 90_000), at)).toBe(false);
    expect(verifyCode(RFC_SEED, currentCode(RFC_SEED, at + 90_000), at)).toBe(false);
  });

  test("refuses rubbish without throwing", () => {
    for (const bad of ["", "abc", "12345", "1234567", "12 34 56", "٠١٢٣٤٥"]) {
      expect(verifyCode(RFC_SEED, bad, at)).toBe(false);
    }
  });
});

describe("secrets at rest", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");

  test("round-trips through encryption", () => {
    process.env.TOTP_ENC_KEY = KEY;
    const secret = generateSecret();
    const stored = encryptSecret(secret);

    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  test("a tampered ciphertext is rejected rather than silently wrong", () => {
    process.env.TOTP_ENC_KEY = KEY;
    const stored = encryptSecret(generateSecret());
    const [iv, tag, data] = stored.split(".");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 0xff;

    expect(() =>
      decryptSecret([iv, tag, flipped.toString("base64url")].join(".")),
    ).toThrow();
  });

  test("refuses to store anything with no key configured", () => {
    delete process.env.TOTP_ENC_KEY;
    expect(() => encryptSecret("ABCDEFGH")).toThrow(/TOTP_ENC_KEY/);
    process.env.TOTP_ENC_KEY = KEY;
  });
});
