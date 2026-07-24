// Category colour palette: stable, index-assigned tags that replace the old
// per-category lane headings. Canonical copy — the classic ui/app.js inlines a
// matching categoryColor() so a pre-update browser can still boot.
export const CATEGORY_PALETTE = [
  { bg: '#5b8def', fg: '#ffffff' }, // blue
  { bg: '#e0794b', fg: '#ffffff' }, // orange
  { bg: '#3bb59a', fg: '#04231c' }, // teal
  { bg: '#9d7be0', fg: '#ffffff' }, // purple
  { bg: '#d1495b', fg: '#ffffff' }, // rose
  { bg: '#4c9f70', fg: '#ffffff' }, // green
  { bg: '#c9a227', fg: '#241f04' }, // amber
  { bg: '#5c7a99', fg: '#ffffff' }, // slate
];

export function categoryColor(categoryId, categoryIds) {
  const index = Array.isArray(categoryIds) ? categoryIds.indexOf(categoryId) : -1;
  const position = index >= 0 ? index : 0;
  return CATEGORY_PALETTE[position % CATEGORY_PALETTE.length];
}
