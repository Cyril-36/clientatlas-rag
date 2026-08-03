import { describe, expect, it } from "vitest";

import {
  buildDocumentObjectPath,
  InvalidStoragePathError,
  organizationIdFromPath,
  parseDocumentObjectPath,
} from "./paths";

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

const location = {
  organizationId: ORG,
  workspaceId: WORKSPACE,
  documentId: DOCUMENT,
  versionId: VERSION,
  mediaType: "application/pdf",
} as const;

describe("buildDocumentObjectPath", () => {
  it("produces the documented layout", () => {
    expect(buildDocumentObjectPath(location)).toBe(
      `organizations/${ORG}/workspaces/${WORKSPACE}/documents/${DOCUMENT}/${VERSION}.pdf`,
    );
  });

  it("uses the docx extension for Word documents", () => {
    const path = buildDocumentObjectPath({
      ...location,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(path.endsWith(`${VERSION}.docx`)).toBe(true);
  });

  it("refuses an identifier that is not a UUID", () => {
    // The only defence that matters: nothing but database identifiers is ever
    // interpolated, so traversal cannot be constructed in the first place.
    expect(() => buildDocumentObjectPath({ ...location, workspaceId: "../../../etc" })).toThrow(
      InvalidStoragePathError,
    );
  });
});

describe("parseDocumentObjectPath", () => {
  it("round-trips a built path", () => {
    const parsed = parseDocumentObjectPath(buildDocumentObjectPath(location));

    expect(parsed).toEqual({
      organizationId: ORG,
      workspaceId: WORKSPACE,
      documentId: DOCUMENT,
      versionId: VERSION,
      extension: "pdf",
    });
  });

  it.each([
    ["a traversal attempt", "organizations/../../etc/passwd"],
    [
      "the wrong root segment",
      `other/${ORG}/workspaces/${WORKSPACE}/documents/${DOCUMENT}/${VERSION}.pdf`,
    ],
    ["a missing segment", `organizations/${ORG}/workspaces/${WORKSPACE}/documents/${VERSION}.pdf`],
    [
      "a non-UUID organisation",
      `organizations/not-a-uuid/workspaces/${WORKSPACE}/documents/${DOCUMENT}/${VERSION}.pdf`,
    ],
    [
      "a trailing extra segment",
      `organizations/${ORG}/workspaces/${WORKSPACE}/documents/${DOCUMENT}/${VERSION}.pdf/x`,
    ],
    [
      "no extension",
      `organizations/${ORG}/workspaces/${WORKSPACE}/documents/${DOCUMENT}/${VERSION}`,
    ],
    ["an empty string", ""],
  ])("returns null for %s", (_label, path) => {
    expect(parseDocumentObjectPath(path)).toBeNull();
    expect(organizationIdFromPath(path)).toBeNull();
  });
});

describe("organizationIdFromPath", () => {
  it("recovers the owning organisation", () => {
    expect(organizationIdFromPath(buildDocumentObjectPath(location))).toBe(ORG);
  });
});
