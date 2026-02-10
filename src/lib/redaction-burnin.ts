/**
 * Phase 6.4: Burn-in redactions onto an image.
 * Used only in the production pipeline (Phase 7) when generating TIFFs.
 * Originals are never altered; redaction rectangles are rendered into the output image.
 *
 * Redaction coordinates (x, y, width, height) are normalized 0–1 relative to image dimensions.
 * Requires optional dependency: npm install sharp
 */

export type RedactionRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Burn redaction rectangles into an image buffer.
 * @param imageBuffer - Input image (JPEG, PNG, etc.)
 * @param redactions - Redactions for this page (normalized 0–1: x, y, width, height)
 * @param imageWidth - Width of the image in pixels
 * @param imageHeight - Height of the image in pixels
 * @returns Buffer of the image with black rectangles drawn over redacted regions (same format as input)
 */
export async function burnInRedactions(
  imageBuffer: Buffer,
  redactions: RedactionRegion[],
  imageWidth: number,
  imageHeight: number
): Promise<Buffer> {
  if (redactions.length === 0) {
    return imageBuffer;
  }

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error(
      "Redaction burn-in requires the 'sharp' package. Install with: npm install sharp. Used only when generating production TIFFs."
    );
  }

  const pipeline = sharp(imageBuffer);
  const metadata = await pipeline.metadata();
  const w = imageWidth || metadata.width || 0;
  const h = imageHeight || metadata.height || 0;
  if (w <= 0 || h <= 0) {
    throw new Error("burnInRedactions: invalid image dimensions");
  }

  const overlays = redactions.map((r) => {
    const left = Math.round(r.x * w);
    const top = Math.round(r.y * h);
    const rw = Math.max(1, Math.round(r.width * w));
    const rh = Math.max(1, Math.round(r.height * h));
    return {
      input: Buffer.alloc(rw * rh * 3, 0),
      raw: { width: rw, height: rh, channels: 3 },
      left,
      top,
    };
  });

  const result = await pipeline
    .composite(overlays)
    .toBuffer({ resolveWithObject: false });
  return result as Buffer;
}
