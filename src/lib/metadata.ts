/**
 * Phase 1.2: Metadata extraction. Uses Tika server if TIKA_SERVER_URL is set,
 * otherwise Node-based extraction (pdf-parse, mammoth) and basic file metadata.
 */

const TIKA_SERVER_URL = process.env.TIKA_SERVER_URL?.replace(/\/$/, ""); // e.g. http://localhost:9998

export type ExtractedMetadata = {
  source: "tika" | "node";
  [key: string]: unknown;
};

/**
 * Extract metadata (and optionally plain text) using Apache Tika server.
 * GET /meta returns JSON metadata; PUT /tika returns extracted text.
 */
async function extractWithTika(
  buffer: Buffer,
  mimeType: string | null
): Promise<{ metadata: Record<string, unknown>; text?: string }> {
  if (!TIKA_SERVER_URL) {
    throw new Error("TIKA_SERVER_URL not set");
  }
  const fetch = (await import("node-fetch")).default;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (mimeType) headers["Content-Type"] = mimeType;

  const [metaRes, tikaRes] = await Promise.all([
    fetch(`${TIKA_SERVER_URL}/meta`, { method: "PUT", body: buffer, headers }),
    fetch(`${TIKA_SERVER_URL}/tika`, { method: "PUT", body: buffer, headers: mimeType ? { "Content-Type": mimeType } : {} }),
  ]);

  let metadata: Record<string, unknown> = {};
  if (metaRes.ok) {
    try {
      const json = (await metaRes.json()) as Record<string, unknown>;
      metadata = { ...json, source: "tika" };
    } catch {
      metadata = { source: "tika" };
    }
  }

  let text: string | undefined;
  if (tikaRes.ok) {
    text = await tikaRes.text();
  }

  return { metadata, text };
}

/**
 * Node-based metadata (and text) extraction for PDF and DOCX.
 * Other types get basic metadata only.
 */
async function extractWithNode(
  buffer: Buffer,
  mimeType: string | null,
  filename: string
): Promise<{ metadata: Record<string, unknown>; text?: string }> {
  const metadata: Record<string, unknown> = {
    source: "node",
    content_type: mimeType,
    size_bytes: buffer.length,
    original_filename: filename,
  };

  let text: string | undefined;

  const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(filename);
  const isDocx =
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(filename);

  if (isPdf) {
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const data = await pdfParse(buffer);
      metadata.pdf_info = data.info ?? {};
      metadata.numpages = data.numpages;
      if (data.text) text = data.text;
    } catch (e) {
      metadata.pdf_error = (e as Error).message;
    }
  } else if (isDocx) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      if (result.value) text = result.value;
    } catch (e) {
      metadata.docx_error = (e as Error).message;
    }
  }

  return { metadata, text };
}

/**
 * Extract metadata (and optionally text) from a document buffer.
 * Uses Tika if TIKA_SERVER_URL is set; otherwise Node-based extraction.
 */
export async function extractMetadata(
  buffer: Buffer,
  options: { mimeType?: string | null; filename?: string }
): Promise<{ metadata: Record<string, unknown>; text?: string }> {
  const mimeType = options.mimeType ?? null;
  const filename = options.filename ?? "";

  if (TIKA_SERVER_URL) {
    try {
      return await extractWithTika(buffer, mimeType);
    } catch (e) {
      console.warn("[metadata] Tika failed, falling back to node:", (e as Error).message);
      return extractWithNode(buffer, mimeType, filename);
    }
  }
  return extractWithNode(buffer, mimeType, filename);
}
