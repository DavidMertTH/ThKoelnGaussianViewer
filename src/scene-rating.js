// Star ratings, 1 to 3, that say how well a scene works or looks. The server keeps them with the scene
// folder; the grid page and the VR panel show one star class at a time and remember which.
export const MAX_RATING = 3;

// value: 'all', or the number of stars, 0 for unrated scenes.
export const RATING_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 3, stars: 3 },
  { value: 2, stars: 2 },
  { value: 1, stars: 1 },
  { value: 0, label: 'Unrated' },
];

const storageKey = 'gaussian-viewer-rating-filter';

export function savedFilter() {
  try {
    const stored = localStorage.getItem(storageKey);
    const filter = RATING_FILTERS.find(({ value }) => String(value) === stored);
    if (filter) return filter.value;
  } catch {}
  return 'all';
}

export function saveFilter(value) {
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {}
  return value;
}

export const passesFilter = (item, filter) => filter === 'all' || (item.rating ?? 0) === filter;

export function filterLabel(filter) {
  if (filter === 'all') return 'all scenes';
  if (filter === 0) return 'unrated scenes';
  return `scenes with ${filter} ${filter === 1 ? 'star' : 'stars'}`;
}

// Scenes opened from the computer are not in the folder and cannot be rated.
export const canRate = (item) => !!item && !item.id.startsWith('local:');

export async function saveRating(item, rating) {
  const response = await fetch(`/api/rating?scene=${encodeURIComponent(item.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating }),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not save the rating.');
}
