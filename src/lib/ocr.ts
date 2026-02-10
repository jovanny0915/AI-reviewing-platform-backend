/**
 * Phase 1.3: OCR pipeline. Tesseract.js (default); extracted text is cached at extracted_text_path.
 * Re-OCR only when forced or when no text was extracted from metadata.
 */

import { createWorker } from "tesseract.js";

const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/bmp",
  "image/gif",
  "image/webp",
]);

/**
 * Returns true if the file type typically needs OCR (image or PDF with no extractable text).
 */
export function needsOcr(mimeType: string | null, filename: string, hasExtractedText: boolean): boolean {
  if (hasExtractedText) return false;
  if (mimeType && IMAGE_MIMES.has(mimeType)) return true;
  const ext = (filename || "").toLowerCase();
  if (/\.(jpe?g|png|tiff?|bmp|gif|webp)$/.test(ext)) return true;
  return false;
}

/**
 * Run Tesseract OCR on an image buffer. Returns extracted text.
 */
export async function runTesseract(buffer: Buffer): Promise<{ text: string; confidence?: number }> {
  const worker = await createWorker("eng", 1, {
    logger: () => {}, // suppress logs
  });
  try {
    const ret = await worker.recognize(buffer);
    return {
      text: ret.data.text ?? "",
      confidence: ret.data.confidence,
    };
  } finally {
    await worker.terminate();
  }
}
