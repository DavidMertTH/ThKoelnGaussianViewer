// Orders for the scene browsers. Scenes are sorted within their folder; the grid page and the VR panel
// share the choice and remember it.
export const SCENE_SORTS = [
  { key: 'name', compare: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) },
  { key: 'size', compare: (a, b) => a.sizeBytes - b.sizeBytes },
  { key: 'added', compare: (a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) },
];

// The entries of the sort menus, each one order in one direction.
export const SORT_OPTIONS = [
  { key: 'name', descending: false, label: 'Name A–Z' },
  { key: 'name', descending: true, label: 'Name Z–A' },
  { key: 'added', descending: true, label: 'Newest' },
  { key: 'added', descending: false, label: 'Oldest' },
  { key: 'size', descending: true, label: 'Largest' },
  { key: 'size', descending: false, label: 'Smallest' },
];

const storageKey = 'gaussian-viewer-scene-sort';
const byKey = (key) => SCENE_SORTS.find((sort) => sort.key === key);

export const sortValue = ({ key, descending }) => `${key}:${descending ? 'desc' : 'asc'}`;
export const sortOption = (sort) => SORT_OPTIONS.find((option) => sortValue(option) === sortValue(sort)) ?? SORT_OPTIONS[0];

// { key, descending }
export function savedSort() {
  try {
    const [key, direction] = (localStorage.getItem(storageKey) ?? '').split(':');
    if (byKey(key)) return sortOption({ key, descending: direction === 'desc' });
  } catch {}
  return SORT_OPTIONS[0];
}

export function saveSort(sort) {
  try {
    localStorage.setItem(storageKey, sortValue(sort));
  } catch {}
  return sortOption(sort);
}

// Ties fall back to the name, so the order is always the same.
export function sortScenes(scenes, { key, descending }) {
  const { compare } = byKey(key) ?? SCENE_SORTS[0];
  const sign = descending ? -1 : 1;
  return [...scenes].sort((a, b) => sign * compare(a, b) || SCENE_SORTS[0].compare(a, b));
}

// The scenes as the browsers list them: folder by folder in the order the folders come, sorted within each.
export function browserOrder(scenes, sort) {
  const folders = new Map();
  for (const item of scenes) {
    const folder = item.id.startsWith('local:') ? 'local:' : item.id.slice(0, Math.max(0, item.id.lastIndexOf('/')));
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(item);
  }
  return [...folders.values()].flatMap((group) => sortScenes(group, sort));
}
