// markers.ts — pure splice helpers for Hume EVI prompt shared-block regions.
//
// Convention:
//   <!-- AIPHIL-SHARED-BEGIN v=<hash> -->
//   ...body...
//   <!-- AIPHIL-SHARED-END -->
//
// Or, for the Discovery-only addendum:
//   <!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN v=<hash> -->
//   ...body...
//   <!-- AIPHIL-DISCOVERY-ADDENDUM-END -->
//
// Splice rules:
// - If the begin+end pair is found, replace everything between them with the
//   new body and update the version annotation.
// - If neither marker is present, prepend a fresh marker block to the prompt.
// - If only begin is present (or only end), throw — the prompt is malformed
//   and a human needs to look at it.

export const SHARED_BEGIN = '<!-- AIPHIL-SHARED-BEGIN';
export const SHARED_END = '<!-- AIPHIL-SHARED-END -->';
export const ADDENDUM_BEGIN = '<!-- AIPHIL-DISCOVERY-ADDENDUM-BEGIN';
export const ADDENDUM_END = '<!-- AIPHIL-DISCOVERY-ADDENDUM-END -->';

export interface MarkerPair {
  begin: string;
  end: string;
}

/** Build a fresh marker block with body + version annotation. */
export function makeMarkerBlock(
  begin: string,
  end: string,
  body: string,
  versionHash: string,
): string {
  return `${begin} v=${versionHash} -->\n${body}\n${end}`;
}

/** Replace the region between begin/end with body+version. If neither marker
 *  is present, prepend a fresh marker block to the prompt. Throws on malformed
 *  regions (begin without end or vice versa). */
export function spliceMarkerRegion(
  prompt: string,
  pair: MarkerPair,
  body: string,
  versionHash: string,
): string {
  const hasBegin = prompt.includes(pair.begin);
  const hasEnd = prompt.includes(pair.end);

  if (hasBegin !== hasEnd) {
    throw new Error(
      `Malformed Hume prompt region: begin=${hasBegin} end=${hasEnd}. ` +
      `Human review required — do NOT sync until resolved.`,
    );
  }

  if (!hasBegin && !hasEnd) {
    // First-run bootstrap: prepend a fresh marker block to the existing prompt.
    const freshBlock = makeMarkerBlock(pair.begin, pair.end, body, versionHash);
    return prompt.startsWith(pair.begin)
      ? prompt
      : `${freshBlock}\n\n${prompt}`;
  }

  // Existing region: regex-replace from begin through end (non-greedy).
  const re = new RegExp(
    `${escapeRe(pair.begin)}[\\s\\S]*?${escapeRe(pair.end)}`,
    'g',
  );
  const freshBlock = makeMarkerBlock(pair.begin, pair.end, body, versionHash);
  return prompt.replace(re, freshBlock);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
