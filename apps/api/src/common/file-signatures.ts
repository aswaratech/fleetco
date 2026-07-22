// Magic-byte file-signature sniffing, shared by every upload surface (the
// common/wkt.ts shared-helper pattern). Promoted here from the agent module in
// ADR-0049 F2 so the documents module can reuse ONE sniffer instead of forking
// it — a cross-module import of another module's internals is forbidden, and a
// duplicated sniffer is exactly the drift the house forbids.
//
// The rule every consumer shares (ADR-0044 c3): the client's asserted
// mimetype is NEVER trusted — a content-type header is an assertion; the
// DETECTED signature is authoritative. Hand-rolled (four signatures) rather
// than a dependency.

/**
 * Sniff the image types the agent-attachment surface allowlists: JPEG
 * `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WEBP `RIFF….WEBP`. Returns the
 * DETECTED content type or null.
 */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Sniff the document types the FleetDocument surface allowlists (ADR-0049 c2):
 * everything {@link sniffImageType} accepts PLUS PDF (`%PDF-`, bytes
 * `25 50 44 46 2D` — the header every real PDF begins with). Returns the
 * DETECTED content type or null. The agent surface deliberately does NOT use
 * this wider sniff — its allowlist stays image-only (photos of receipts), so
 * each surface calls the sniffer matching its own contract.
 */
export function sniffDocumentType(bytes: Buffer): string | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return sniffImageType(bytes);
}
