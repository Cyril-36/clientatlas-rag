import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_FILE_BYTES, sanitizeFilename, validateFile } from "./validation";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A minimal byte sequence that passes the PDF signature check. */
function pdfBytes(body = "1 0 obj\n<< /Type /Catalog >>\nendobj\n"): Uint8Array {
  return new Uint8Array(Buffer.from(`%PDF-1.7\n${body}%%EOF\n`, "latin1"));
}

/** A ZIP header plus the two names the Open Packaging Convention requires. */
function docxBytes(): Uint8Array {
  const header = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const names = Buffer.from("[Content_Types].xml word/document.xml word/styles.xml", "latin1");
  return new Uint8Array(Buffer.concat([header, names]));
}

/** A ZIP that is not a DOCX — the case a magic-byte-only check would let through. */
function plainZipBytes(): Uint8Array {
  const header = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const names = Buffer.from("holiday-photos/img001.jpg notes.txt", "latin1");
  return new Uint8Array(Buffer.concat([header, names]));
}

describe("validateFile", () => {
  it("accepts a PDF whose bytes, media type and extension agree", () => {
    const result = validateFile({
      filename: "handbook.pdf",
      declaredMediaType: PDF,
      bytes: pdfBytes(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mediaType).toBe(PDF);
    expect(result.sanitizedFilename).toBe("handbook.pdf");
    expect(result.checksumSha256).toBe(createHash("sha256").update(pdfBytes()).digest("hex"));
  });

  it("accepts a DOCX", () => {
    const result = validateFile({
      filename: "onboarding.docx",
      declaredMediaType: DOCX,
      bytes: docxBytes(),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a ZIP that is not a DOCX", () => {
    // The whole reason the signature check looks past the magic bytes: every
    // DOCX is a ZIP, so accepting any ZIP would accept arbitrary archives.
    const result = validateFile({
      filename: "onboarding.docx",
      declaredMediaType: DOCX,
      bytes: plainZipBytes(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FILE_UNREADABLE");
  });

  it("rejects a PDF renamed to .docx and declared as DOCX", () => {
    const result = validateFile({
      filename: "handbook.docx",
      declaredMediaType: DOCX,
      bytes: pdfBytes(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(result.message).toMatch(/do not match/i);
  });

  it("rejects a PDF whose filename does not use .pdf", () => {
    const result = validateFile({
      filename: "handbook.txt",
      declaredMediaType: PDF,
      bytes: pdfBytes(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects an unsupported declared media type", () => {
    const result = validateFile({
      filename: "sheet.csv",
      declaredMediaType: "text/csv",
      bytes: new Uint8Array(Buffer.from("a,b,c", "latin1")),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects an executable renamed to .pdf", () => {
    const machO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

    const result = validateFile({
      filename: "handbook.pdf",
      declaredMediaType: PDF,
      bytes: machO,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FILE_UNREADABLE");
  });

  it("rejects an empty file", () => {
    const result = validateFile({
      filename: "empty.pdf",
      declaredMediaType: PDF,
      bytes: new Uint8Array(0),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FILE_UNREADABLE");
  });

  it("rejects a file over the size limit", () => {
    const result = validateFile({
      filename: "big.pdf",
      declaredMediaType: PDF,
      bytes: pdfBytes(),
      maxBytes: 8,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects a password-protected PDF with a clear reason", () => {
    const result = validateFile({
      filename: "secret.pdf",
      declaredMediaType: PDF,
      bytes: pdfBytes("trailer\n<< /Encrypt 5 0 R /Root 1 0 R >>\n"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FILE_ENCRYPTED");
    expect(result.message).toMatch(/password/i);
  });

  it("defaults to a 25 MB limit", () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("sanitizeFilename", () => {
  it("keeps an ordinary name unchanged", () => {
    expect(sanitizeFilename("Employee Handbook 2026.pdf")).toBe("Employee Handbook 2026.pdf");
  });

  it("strips POSIX and Windows path components", () => {
    expect(sanitizeFilename("../../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("C:\\Users\\cyril\\handbook.pdf")).toBe("handbook.pdf");
  });

  it("removes control characters", () => {
    const withControls = `hand${String.fromCharCode(0)}book${String.fromCharCode(10)}.pdf`;

    expect(sanitizeFilename(withControls)).toBe("handbook.pdf");
  });

  it("removes bidirectional overrides used to disguise an extension", () => {
    // U+202E makes the rest of the string render right-to-left, so this
    // displays as "invoice exe.pdf" while actually ending in .exe.
    const disguised = `invoice${String.fromCharCode(0x202e)}fdp.exe`;

    const result = sanitizeFilename(disguised);

    expect(result).toBe("invoicefdp.exe");
    expect(result).not.toContain(String.fromCharCode(0x202e));
  });

  it("falls back to a placeholder for names that reduce to nothing", () => {
    expect(sanitizeFilename("")).toBe("document");
    expect(sanitizeFilename("..")).toBe("document");
    expect(sanitizeFilename("/")).toBe("document");
  });

  it("preserves the extension when truncating a very long name", () => {
    const long = `${"a".repeat(400)}.pdf`;

    const result = sanitizeFilename(long);

    expect(result.endsWith(".pdf")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("keeps non-Latin characters", () => {
    expect(sanitizeFilename("नियमावली.pdf")).toBe("नियमावली.pdf");
  });
});
