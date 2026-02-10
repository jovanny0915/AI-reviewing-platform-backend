/**
 * Phase 7.1–7.3: TIFF conversion, Bates stamping, placeholders.
 * Images → single-page TIFF via sharp; PDF/other → placeholder or optional converter.
 */

import { burnInRedactions, type RedactionRegion } from "./redaction-burnin.js";

const IMAGE_MIMES = new Set([
  "image/tiff",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const PDF_MIME = "application/pdf";

export type BatesOptions = {
  prefix: string;
  startNumber: number;
  /** Zero-pad to this length (e.g. 6 => PROD000001) */
  padLength?: number;
};

/**
 * Format a Bates number: prefix + zero-padded number (e.g. ABC000001).
 */
export function formatBatesNumber(
  prefix: string,
  seq: number,
  padLength = 6
): string {
  const safePrefix = (prefix || "PROD").replace(/[^A-Za-z0-9]/g, "");
  const num = String(seq).padStart(padLength, "0");
  return `${safePrefix}${num}`;
}

/**
 * Create a single-page TIFF from an image buffer (JPEG, PNG, etc.) with optional Bates overlay and redaction burn-in.
 */
export async function imageToTiff(
  imageBuffer: Buffer,
  options: {
    batesNumber?: string;
    redactions?: RedactionRegion[];
    imageWidth?: number;
    imageHeight?: number;
  } = {}
): Promise<Buffer> {
  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error(
      "TIFF production requires 'sharp'. Install with: npm install sharp"
    );
  }

  let buf = imageBuffer;
  const metadata = await sharp(buf).metadata();
  const w = options.imageWidth ?? metadata.width ?? 0;
  const h = options.imageHeight ?? metadata.height ?? 0;

  if (options.redactions?.length) {
    buf = await burnInRedactions(
      buf,
      options.redactions,
      w as number,
      h as number
    );
  }

  let pipeline = sharp(buf);
  if (options.batesNumber) {
    const svg = createBatesSvg(options.batesNumber, w as number, h as number);
    pipeline = pipeline.composite([
      {
        input: Buffer.from(svg),
        top: 0,
        left: 0,
      },
    ]);
  }

  const tiff = await pipeline.tiff().toBuffer();
  return tiff;
}

/**
 * Create an SVG overlay for Bates text (bottom-right corner).
 */
function createBatesSvg(
  batesNumber: string,
  imageWidth: number,
  imageHeight: number
): string {
  const x = Math.max(0, imageWidth - 220);
  const y = Math.max(0, imageHeight - 40);
  const fontSize = Math.min(24, Math.floor(imageHeight / 30));
  return `<svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">
  <text x="${x}" y="${y + fontSize}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="black" font-weight="bold">${escapeXml(batesNumber)}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Create a placeholder TIFF image: "Document produced in native format" (single page).
 */
export async function createPlaceholderTiff(
  batesNumber: string,
  nativeFilename?: string
): Promise<Buffer> {
  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw new Error(
      "Placeholder TIFF requires 'sharp'. Install with: npm install sharp"
    );
  }

  const width = 612;
  const height = 792;
  const line1 = "Document produced in native format";
  const line2 = nativeFilename ? `File: ${nativeFilename}` : "";

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#f5f5f5"/>
  <text x="50" y="320" font-family="Arial, sans-serif" font-size="18" fill="#333">${escapeXml(line1)}</text>
  ${line2 ? `<text x="50" y="350" font-family="Arial, sans-serif" font-size="14" fill="#666">${escapeXml(line2)}</text>` : ""}
  <text x="${width - 200}" y="${height - 30}" font-family="Arial, sans-serif" font-size="14" fill="#000" font-weight="bold">${escapeXml(batesNumber)}</text>
</svg>`;

  const tiff = await sharp(Buffer.from(svg)).tiff().toBuffer();
  return tiff;
}

/**
 * Check if we can convert the file to TIFF (image type). PDF may be supported if converter available.
 */
export function canConvertToTiff(mimeType: string | null): "image" | "pdf" | "placeholder" {
  if (!mimeType) return "placeholder";
  if (IMAGE_MIMES.has(mimeType)) return "image";
  if (mimeType === PDF_MIME) return "pdf";
  return "placeholder";
}

/** pdf2pic converter: call with (pageNumber, options) returns Promise<{ buffer?: Buffer }>. */
type Pdf2PicConverter = (page: number, opts?: { responseType: string }) => Promise<{ buffer?: Buffer }>;

/**
 * Convert PDF buffer to one TIFF per page. Uses pdf2pic if available (requires GraphicsMagick);
 * otherwise returns [] and caller should use a single placeholder TIFF for the document.
 */
export async function pdfToTiffPages(
  pdfBuffer: Buffer
): Promise<{ pageNumber: number; tiffBuffer: Buffer }[]> {
  try {
    const { fromBuffer } = await import("pdf2pic");
    const options = { density: 300, format: "tiff" };
    const converter = fromBuffer(pdfBuffer, options) as Pdf2PicConverter;
    const pages: { pageNumber: number; tiffBuffer: Buffer }[] = [];
    let pageNum = 1;
    for (;;) {
      const result = await converter(pageNum, { responseType: "buffer" });
      if (!result?.buffer || result.buffer.length === 0) break;
      pages.push({ pageNumber: pageNum, tiffBuffer: result.buffer });
      pageNum++;
    }
    return pages;
  } catch {
    return [];
  }
}
