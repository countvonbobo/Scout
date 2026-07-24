// Category colour palette: stable, index-assigned tags that replace the old
// per-category lane headings. Canonical copy — the classic ui/app.js inlines a
// matching categoryColor() so a pre-update browser can still boot.
export const CATEGORY_PALETTE = [
  { bg: '#4a73c3', fg: '#ffffff' }, // blue
  { bg: '#b05f3b', fg: '#ffffff' }, // orange
  { bg: '#3bb59a', fg: '#04231c' }, // teal
  { bg: '#8266ba', fg: '#ffffff' }, // purple
  { bg: '#ca4658', fg: '#ffffff' }, // rose
  { bg: '#3e825c', fg: '#ffffff' }, // green
  { bg: '#c9a227', fg: '#241f04' }, // amber
  { bg: '#5a7896', fg: '#ffffff' }, // slate
];

export function categoryColor(categoryId, categoryIds) {
  const index = Array.isArray(categoryIds) ? categoryIds.indexOf(categoryId) : -1;
  const position = index >= 0 ? index : 0;
  return CATEGORY_PALETTE[position % CATEGORY_PALETTE.length];
}
