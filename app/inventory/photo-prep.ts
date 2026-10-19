/**
 * A photo made fit to send, in the browser: upright, at most 2048 px on its
 * long edge, redrawn as a JPEG on white — so nothing the camera wrote into it
 * (where it was taken included) leaves the phone — and its SHA-256, which the
 * portal checks. A photo this browser cannot redraw is not sent at all.
 *
 * Shared by the capture screen and a container's purchase paperwork.
 */

const MAX_EDGE = 2048;
const QUALITY = 0.85;
const MAX_BYTES = 9 * 1024 * 1024;


const isHeic = (file: File) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

type Decoded = { source: CanvasImageSource; width: number; height: number; done: () => void };

/** The photo as pixels, upright: createImageBitmap first, an <img> (which Safari decodes HEIC into) second. */
async function decode(file: File): Promise<Decoded | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
  } catch {
    /* fall through */
  }
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    return null;
  }
}

export async function prepare(file: File): Promise<{ blob: Blob; name: string }> {
  const decoded = await decode(file);
  const stem = (file.name || "photo").replace(/\.[^.]+$/, "").slice(0, 80) || "photo";
  if (!decoded || !decoded.width || !decoded.height) {
    decoded?.done();
    // Sent as it is, a photo would keep everything the camera wrote into it —
    // where it was taken included — so a photo this browser cannot redraw is
    // not sent at all.
    throw new Error(
      isHeic(file)
        ? "This browser cannot open HEIC photos. Use the camera button, or choose a JPEG (on iPhone: Settings › Camera › Formats › Most Compatible)."
        : "This browser could not open that photo.",
    );
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    decoded.done();
    throw new Error("This browser could not prepare the photo.");
  }
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded.source, 0, 0, width, height);
  decoded.done();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
  canvas.width = canvas.height = 0; // let iOS have the memory back now
  if (!blob) throw new Error("This browser could not prepare the photo.");
  if (blob.size > MAX_BYTES) throw new Error("That photo is too large to send.");
  return { blob, name: `${stem}.jpg` };
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
