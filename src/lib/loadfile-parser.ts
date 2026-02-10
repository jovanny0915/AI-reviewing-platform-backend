/**
 * Phase 8: Load file parsing — read Concordance-style DAT and Opticon OPT.
 * Maps to internal metadata: Bates, image path, native path, page count.
 */

export type ParsedLoadFileRecord = {
  begBates: string;
  endBates: string;
  imagePath: string;
  nativePath: string;
  pageCount: number;
};

export type ParseResult = {
  records: ParsedLoadFileRecord[];
  errors: string[];
};

const DELIMITERS = /[\t,]/;
const COMMON_HEADERS = [
  ["begbates", "endbates", "imagepath", "nativepath", "pagecount"],
  ["beg_bates", "end_bates", "image_path", "native_path", "page_count"],
  ["control number", "beg bates", "end bates", "image path", "native path", "page count"],
];

/**
 * Normalize header cell for matching: lowercase, trim, collapse spaces.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Find column indices from header row. Returns indices for begBates, endBates, imagePath, nativePath, pageCount.
 */
function findColumnIndices(
  headers: string[]
): { beg: number; end: number; image: number; native: number; page: number } | null {
  const n = headers.map(norm);
  const beg = n.findIndex((h) => h === "begbates" || h === "beg_bates" || h === "beg bates");
  const end = n.findIndex((h) => h === "endbates" || h === "end_bates" || h === "end bates");
  const image = n.findIndex((h) => h === "imagepath" || h === "image_path" || h === "image path" || h === "imagpath");
  const native = n.findIndex((h) => h === "nativepath" || h === "native_path" || h === "native path");
  const page = n.findIndex((h) => h === "pagecount" || h === "page_count" || h === "page count" || h === "pages");
  if (beg >= 0 && end >= 0 && image >= 0 && native >= 0 && page >= 0) {
    return { beg, end, image, native, page };
  }
  if (beg >= 0 && end >= 0 && (image >= 0 || native >= 0)) {
    return {
      beg,
      end,
      image: image >= 0 ? image : native,
      native: native >= 0 ? native : image,
      page: page >= 0 ? page : -1,
    };
  }
  return null;
}

/**
 * Parse DAT or OPT content (tab- or comma-delimited). First line = header.
 */
export function parseLoadFile(content: string): ParseResult {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { records: [], errors: ["Empty file"] };
  }
  const headerLine = lines[0];
  const headers = headerLine.split(DELIMITERS).map((c) => c.trim());
  const cols = findColumnIndices(headers);
  if (!cols) {
    return {
      records: [],
      errors: [`Unrecognized header. Expected columns like BEGBATES, ENDBATES, IMAGEPATH, NATIVEPATH, PAGECOUNT. Got: ${headerLine.slice(0, 200)}`],
    };
  }
  const records: ParsedLoadFileRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(DELIMITERS);
    const beg = (parts[cols.beg] ?? "").trim();
    const end = (parts[cols.end] ?? "").trim();
    const imagePath = (parts[cols.image] ?? "").trim();
    const nativePath = (parts[cols.native] ?? "").trim();
    const pageCount = cols.page >= 0 ? parseInt(parts[cols.page] ?? "0", 10) : 1;
    if (!beg && !end) continue;
    records.push({
      begBates: beg || end,
      endBates: end || beg,
      imagePath,
      nativePath,
      pageCount: Number.isNaN(pageCount) || pageCount < 0 ? 1 : pageCount,
    });
  }
  return { records, errors };
}
