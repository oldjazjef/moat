/** A media type as configured and compared: lower case `type/subtype`, no parameters. */
export const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/**
 * FR-18: the media type of a Content-Type header value (`Application/JSON; charset=utf-8` →
 * `application/json`), or null when the value is not a well-formed media type.
 */
export function mediaTypeOf(header: string): string | null {
  // Only spaces and tabs count as whitespace here (RFC 9110 OWS), the same in every gate.
  const raw = (header.split(';', 1)[0] ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
  // ASCII only before lower-casing: JavaScript would fold e.g. the Kelvin sign to "k", PHP not.
  if (!/^[\x21-\x7e]*$/.test(raw)) return null;
  const type = raw.toLowerCase();
  return MEDIA_TYPE.test(type) ? type : null;
}

/** True when the header's media type is one of the allowed ones (exact match). */
export function isAllowedContentType(
  header: string,
  allowed: readonly string[],
): boolean {
  const type = mediaTypeOf(header);
  return type !== null && allowed.includes(type);
}
