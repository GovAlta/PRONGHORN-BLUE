/**
 * Sanitize a URL intended for use as an image `src`.
 *
 * Only root-relative paths (starting with `/`), `http(s)` URLs, and
 * `data:image/*` URLs are permitted. Any other scheme (notably `javascript:`,
 * `vbscript:`, or `data:text/html`) and bare relative paths are rejected and the
 * empty string is returned, so a value derived from model/user-supplied content
 * cannot introduce script execution when interpolated into an `<img src>`
 * attribute.
 *
 * @param url - The candidate image URL (may be any type / malformed).
 * @returns A safe URL string, or `""` when the input is missing or unsafe.
 * @example
 *   <img src={sanitizeImageUrl(slide.imageUrl)} />
 */
export function sanitizeImageUrl(url: unknown): string {
  if (typeof url !== "string") {
    return "";
  }

  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return "";
  }

  // Root-relative path (no scheme) — safe.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  // Explicitly allow only image data URLs and http(s) URLs.
  if (/^data:image\/[a-z0-9.+-]+[,;]/i.test(trimmed)) {
    return trimmed;
  }

  // Only absolute URLs (with an explicit scheme) are parsed below. Reject any
  // remaining relative path that does not start with "/" so a value cannot be
  // silently resolved against the page origin.
  if (!trimmed.includes("://")) {
    return "";
  }

  try {
    // Parse without a base so an absolute URL is never reinterpreted as
    // same-origin; the protocol allowlist then rejects non-http(s) schemes.
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // Fall through to reject malformed URLs.
  }

  return "";
}
