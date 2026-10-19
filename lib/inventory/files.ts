/**
 * What an inventory photo may be, decided from its bytes.
 *
 * The browser's word for a file's type is a hint; the first bytes are the
 * file. A photo is kept only as one of the image types login's 0048 allows
 * for inventory documents, and its object key gets the extension that type
 * has there (HEIF and HEIC share `.heic`).
 *
 * Plain functions, no imports: the upload route and the tests share them.
 */

export type PhotoType = {
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";
  extension: "jpg" | "png" | "webp" | "heic";
};

/**
 * The largest photo one upload takes. The portal refuses requests over 10MB
 * before they reach a route, and the form around the file needs a little
 * room. The capture screen sends a JPEG of about 1MB; this is for the
 * original HEIC a browser could not convert.
 */
export const MAX_PHOTO_BYTES = 9 * 1024 * 1024;

/** HEIF brands (ISO/IEC 23008-12): the HEVC-coded ones are HEIC. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

export function sniffPhoto(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return { contentType: "image/heic", extension: "heic" };
    if (HEIF_BRANDS.has(brand)) return { contentType: "image/heif", extension: "heic" };
  }
  return null;
}

/** The types a vision model can be shown. HEIC/HEIF are kept but not sent. */
export function modelCanRead(contentType: string): boolean {
  return contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp";
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A SHA-256 as the browser sends it: 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
