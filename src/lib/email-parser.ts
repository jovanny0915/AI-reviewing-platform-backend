/**
 * Phase 2.2: Email parsing for family linking. MSG (Outlook) and EML (MIME) support.
 * Extracts attachments so each can become a child document with same family_id.
 */

import { simpleParser, Attachment, type AddressObject } from "mailparser";

export type ParsedEmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export type ParsedEmailResult = {
  isEmail: true;
  /** Set when parsing failed (e.g. corrupt or unsupported file); other fields may be empty. */
  parseError?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: Date;
  text?: string;
  html?: string;
  attachments: ParsedEmailAttachment[];
};

export type NotEmailResult = { isEmail: false };

/**
 * Detect if buffer is an email by MIME type or filename extension.
 */
export function isEmailFile(mimeType: string | null, filename: string): boolean {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".eml") || lower.endsWith(".msg")) return true;
  if (
    mimeType === "message/rfc822" ||
    mimeType === "application/vnd.ms-outlook" ||
    mimeType === "application/x-msg"
  ) {
    return true;
  }
  return false;
}

/**
 * Parse EML (MIME) using mailparser.
 */
async function parseEml(buffer: Buffer): Promise<ParsedEmailResult> {
  const parsed = await simpleParser(buffer, {});
  const attachments: ParsedEmailAttachment[] = [];
  if (parsed.attachments?.length) {
    for (const a of parsed.attachments as Attachment[]) {
      const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
      attachments.push({
        filename: a.filename || a.contentType?.split("/")[0] || "attachment",
        content,
        contentType: typeof a.contentType === "string" ? a.contentType : undefined,
      });
    }
  }
  // Prefer plain text; if only HTML, strip to text for extracted_text_path
  let text = parsed.text?.trim() ?? undefined;
  if (!text && parsed.html) {
    text = stripHtmlToText(String(parsed.html));
  }

  return {
    isEmail: true,
    subject: parsed.subject ?? undefined,
    from: formatAddress(parsed.from),
    to: formatAddress(parsed.to),
    date: parsed.date ?? undefined,
    text,
    html: parsed.html ? String(parsed.html) : undefined,
    attachments,
  };
}

/**
 * Parse Outlook MSG using @kenjiuno/msgreader.
 */
async function parseMsg(buffer: Buffer): Promise<ParsedEmailResult> {
  const { default: MsgReaderClass } = await import("@kenjiuno/msgreader");
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const msg = new (MsgReaderClass as any)(arrayBuffer);
  const fileData = msg.getFileData();
  const attachments: ParsedEmailAttachment[] = [];

  if (fileData?.attachments?.length) {
    for (let i = 0; i < fileData.attachments.length; i++) {
      const attMeta = fileData.attachments[i];
      const attResult = msg.getAttachment(attMeta);
      const filename =
        (attMeta as { fileName?: string }).fileName ??
        (attMeta as { displayName?: string }).displayName ??
        (attResult as { fileName?: string })?.fileName ??
        `attachment_${i}`;
      const content = (attResult as { content?: Uint8Array })?.content;
      if (content && content.length) {
        attachments.push({
          filename,
          content: Buffer.from(content),
        });
      }
    }
  }

  type Recipient = { name?: string; email?: string };
  const recipients: Recipient[] = fileData?.recipients ?? [];
  const toStr = recipients
    .map((r) => (r.name ? `${r.name} <${r.email}>` : r.email))
    .filter(Boolean)
    .join(", ");

  // Body: plain text preferred; then bodyHtml (string); then html (Uint8Array, common in Outlook MSG)
  let text: string | undefined = fileData?.body?.trim() || undefined;
  if (!text && (fileData as { bodyHtml?: string })?.bodyHtml) {
    text = stripHtmlToText((fileData as { bodyHtml: string }).bodyHtml);
  }
  if (!text && (fileData as { html?: Uint8Array })?.html) {
    const htmlBytes = (fileData as { html: Uint8Array }).html;
    const decoded = decodeHtmlBytes(htmlBytes);
    if (decoded) text = stripHtmlToText(decoded);
  }

  return {
    isEmail: true,
    subject: fileData?.subject,
    from: fileData?.senderName ? (fileData.senderEmail ? `${fileData.senderName} <${fileData.senderEmail}>` : fileData.senderName) : fileData?.senderEmail,
    to: toStr || undefined,
    date: fileData?.creationTime ? new Date(fileData.creationTime) : undefined,
    text,
    attachments,
  };
}

/** Format address(es) to a single string for from/to. */
function formatAddress(o: AddressObject | AddressObject[] | undefined): string | undefined {
  if (!o) return undefined;
  const one = Array.isArray(o) ? o[0] : o;
  return one?.text ?? undefined;
}

/** Decode HTML stored as Uint8Array (e.g. MSG PidTagHtml). Outlook often uses UTF-16LE. */
function decodeHtmlBytes(bytes: Uint8Array): string | undefined {
  if (!bytes?.length) return undefined;
  const buf = Buffer.from(bytes);
  // UTF-16LE BOM (0xFF 0xFE) or likely UTF-16LE if buffer length is even and starts with < (0x3C 0x00)
  if (buf.length >= 2 && buf[1] === 0x00 && (buf[0] === 0x3c || buf[0] === 0xff)) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

/** Simple HTML strip for email body (bodyHtml) so we have plain text for extraction. */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse an email buffer (EML or MSG). Returns { isEmail: false } if not an email type.
 */
export async function parseEmail(
  buffer: Buffer,
  options: { mimeType?: string | null; filename?: string }
): Promise<ParsedEmailResult | NotEmailResult> {
  const { mimeType, filename = "" } = options;
  if (!isEmailFile(mimeType ?? null, filename)) {
    return { isEmail: false };
  }

  const lower = filename.toLowerCase();
  if (lower.endsWith(".msg")) {
    try {
      return await parseMsg(buffer);
    } catch (e) {
      const message = (e as Error).message ?? "Unknown error";
      console.warn("[email-parser] MSG parse error:", message);
      return {
        isEmail: true,
        parseError: `Email parsing failed: ${message}`,
        attachments: [],
      };
    }
  }

  try {
    return await parseEml(buffer);
  } catch (e) {
    const message = (e as Error).message ?? "Unknown error";
    console.warn("[email-parser] EML parse error:", message);
    return {
      isEmail: true,
      parseError: `Email parsing failed: ${message}`,
      attachments: [],
    };
  }
}
