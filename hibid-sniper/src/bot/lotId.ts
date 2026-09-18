/**
 * Pull the numeric HiBid lot / event-item id out of a lot URL.
 * Real URLs observed:
 *   https://hibid.com/florida/lot/320694969
 *   https://hibid.com/florida/lot/320694969/some-slug
 *   https://hibid.com/lot/320694969/...
 */
export function extractLotId(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/lot\/(\d+)/i);
    return match ? match[1] : null;
  } catch {
    const match = String(url).match(/\/lot\/(\d+)/i);
    return match ? match[1] : null;
  }
}

/** Build a stable lot URL from an id (regional path is optional; /lot/:id works in-app). */
export function lotUrlFromId(lotId: string | number, region?: string): string {
  if (region) return `https://hibid.com/${region}/lot/${lotId}`;
  return `https://hibid.com/lot/${lotId}`;
}
