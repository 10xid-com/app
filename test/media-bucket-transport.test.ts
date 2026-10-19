import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putObject } from "@/lib/integrations/media-bucket";

// Keep the real aws4fetch signer and native Request: a mock of AwsClient.fetch
// misses the streamed request body that requires an explicit S3 Content-Length.
describe("media bucket object upload transport", () => {
  beforeEach(() => {
    vi.stubEnv("MEDIA_BUCKET_ENDPOINT", "https://bucket.example.invalid");
    vi.stubEnv("MEDIA_BUCKET_NAME", "test-media");
    vi.stubEnv("MEDIA_BUCKET_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("MEDIA_BUCKET_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("MEDIA_BUCKET_REGION", "auto");
    vi.stubEnv("MEDIA_BUCKET_PATH_STYLE", "true");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "complete byte array", body: new Uint8Array([255, 216, 255, 217]) },
    // The backing buffer is larger than the bytes actually sent.
    { name: "subarray view", body: new Uint8Array([99, 255, 216, 255, 217, 88]).subarray(1, 5) },
    { name: "empty object", body: new Uint8Array(0) },
  ])("sends the exact Content-Length for a $name", async ({ body }) => {
    let transmitted: Request | undefined;
    const fetchMock = vi.fn(async (request: Request) => {
      transmitted = request;
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await putObject("inventory/test/label.jpg", body, "image/jpeg");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transmitted).toBeInstanceOf(Request);
    expect(transmitted!.method).toBe("PUT");
    expect(transmitted!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(transmitted!.headers.get("content-type")).toBe("image/jpeg");
    expect(transmitted!.headers.get("content-length")).toBe(String(body.byteLength));
    expect(new Uint8Array(await transmitted!.arrayBuffer())).toEqual(body);
  });
});
