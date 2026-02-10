/**
 * Phase 7.4: Load file generation — DAT (Concordance-style) and OPT (Opticon).
 * Volume/path to TIFF and native path for each document.
 */

export type LoadFileRecord = {
  begBates: string;
  endBates: string;
  imagePath: string;
  nativePath: string;
  pageCount: number;
  /** Optional: control id or doc identifier */
  controlId?: string;
};

/**
 * Generate DAT (Concordance-style) content. Tab-delimited; header row.
 */
export function generateDat(records: LoadFileRecord[]): string {
  const header = "BEGBATES\tENDBATES\tIMAGEPATH\tNATIVEPATH\tPAGECOUNT";
  const lines = records.map(
    (r) =>
      `${r.begBates}\t${r.endBates}\t${r.imagePath}\t${r.nativePath}\t${r.pageCount}`
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

/**
 * Generate OPT (Opticon-style) content. Tab-delimited; similar columns.
 */
export function generateOpt(records: LoadFileRecord[]): string {
  const header = "BEGBATES\tENDBATES\tIMAGEPATH\tNATIVEPATH\tPAGECOUNT";
  const lines = records.map(
    (r) =>
      `${r.begBates}\t${r.endBates}\t${r.imagePath}\t${r.nativePath}\t${r.pageCount}`
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}
