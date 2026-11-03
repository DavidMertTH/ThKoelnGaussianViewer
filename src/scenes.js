import { SORT_OPTIONS, saveSort, savedSort, sortScenes, sortValue } from './scene-sort.js';

const $ = (selector) => document.querySelector(selector);
const browser = $('#scene-browser');
const folderButton = $('#folder-button');
const reloadButton = $('#reload-button');
const thumbnailsLink = $('#thumbnails-link');
const sortSelect = $('#sort-select');
const searchInput = $('#scene-search');
let query = '';
let sort = savedSort();
let shownLibrary = null;

function formatBytes(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} MB` : `${Math.ceil(bytes / 1e3)} kB`;
}

function message(text) {
  const paragraph = document.createElement('p');
  paragraph.className = 'browser-message';
  paragraph.textContent = text;
  return paragraph;
}

const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Every word of the search has to start a word of the scene's name or folder, so "cat 1" finds Cat 1
// and Cat 10. The capture timestamp at the end of a name (_20261029-112740) is left out of the search.
function matches(item, folder) {
  const own = words(`${item.name.replace(/[_-]\d{8}-\d{6}$/, '')} ${folder}`);
  return words(query).every((word) => own.some((candidate) => candidate.startsWith(word)));
}

// One section per folder that holds scenes directly, titled with its path below the scene folder.
function sections(node, trail = []) {
  const own = node.scenes.length ? [{ title: trail.join(' / '), scenes: node.scenes }] : [];
  return [...own, ...node.folders.flatMap((child) => sections(child, [...trail, child.name]))];
}

function sceneCard(item) {
  const card = document.createElement('a');
  card.className = 'scene-card';
  card.href = `/viewer.html?scene=${encodeURIComponent(item.id)}`;
  card.title = item.name;
  const preview = item.thumbUrl || item.imageUrl;
  if (preview) {
    const image = document.createElement('img');
    image.src = preview;
    image.alt = '';
    image.width = 480;
    image.height = 300;
    image.loading = 'lazy';
    image.decoding = 'async';
    card.append(image);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'scene-card-placeholder';
    placeholder.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="m24 6 15 8.5v17L24 40 9 31.5v-17z" /><path d="m9 14.5 15 8.5 15-8.5M24 23v17" /></svg>';
    card.append(placeholder);
  }
  const copy = document.createElement('span');
  copy.className = 'scene-card-copy';
  const name = document.createElement('span');
  name.className = 'scene-card-name';
  name.textContent = item.name;
  const size = document.createElement('span');
  size.className = 'scene-card-size';
  size.textContent = formatBytes(item.sizeBytes);
  copy.append(name, size);
  card.append(copy);
  return card;
}

function render(library) {
  folderButton.hidden = !library.canChooseFolder;
  shownLibrary = library;
  sortSelect.value = sortValue(sort);
  const all = sections(library.tree);
  const groups = all
    .map((group) => ({ ...group, scenes: sortScenes(group.scenes.filter((item) => matches(item, group.title)), sort) }))
    .filter((group) => group.scenes.length);
  const total = all.reduce((sum, group) => sum + group.scenes.length, 0);
  const shown = groups.reduce((sum, group) => sum + group.scenes.length, 0);
  $('#scene-count').textContent = query ? `${shown} of ${total} scenes` : `${total} ${total === 1 ? 'scene' : 'scenes'}`;
  // Thumbnails are made by the viewer; only offer the batch run on the computer with the scenes.
  const missing = all.reduce((sum, group) => sum + group.scenes.filter((item) => !item.thumbUrl).length, 0);
  thumbnailsLink.hidden = !library.canChooseFolder || !missing;
  $('#thumbnails-label').textContent = `Create ${missing} ${missing === 1 ? 'thumbnail' : 'thumbnails'}`;
  if (!library.exists) {
    browser.replaceChildren(message('The scene folder does not exist.'));
    return;
  }
  if (!total) {
    browser.replaceChildren(message('The scene folder has no splat files yet.'));
    return;
  }
  if (!shown) {
    browser.replaceChildren(message(`No scenes match “${query}”.`));
    return;
  }
  browser.replaceChildren(...groups.map((group) => {
    const section = document.createElement('section');
    section.className = 'scene-section';
    if (group.title) {
      const heading = document.createElement('h2');
      heading.textContent = group.title;
      section.append(heading);
    }
    const grid = document.createElement('div');
    grid.className = 'scene-grid';
    grid.append(...group.scenes.map(sceneCard));
    section.append(grid);
    return section;
  }));
}

async function load(request) {
  reloadButton.disabled = true;
  folderButton.disabled = true;
  try {
    const response = await request();
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load scenes.');
    if (data.changed !== false) render(data);
  } catch (error) {
    browser.replaceChildren(message(error.message));
  } finally {
    reloadButton.disabled = false;
    folderButton.disabled = false;
  }
}

for (const option of SORT_OPTIONS) sortSelect.add(new Option(option.label, sortValue(option)));
sortSelect.value = sortValue(sort);
sortSelect.addEventListener('change', () => {
  sort = saveSort(SORT_OPTIONS.find((option) => sortValue(option) === sortSelect.value));
  if (shownLibrary) render(shownLibrary);
});

searchInput.addEventListener('input', () => {
  query = searchInput.value.trim();
  if (shownLibrary) render(shownLibrary);
});
// "/" jumps to the search, Escape clears it.
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key === 'Escape' && document.activeElement === searchInput && searchInput.value) {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
  }
});

reloadButton.addEventListener('click', () => load(() => fetch('/api/scenes', { cache: 'no-store' })));
folderButton.addEventListener('click', () => load(() => fetch('/api/folder', { method: 'POST' })));
load(() => fetch('/api/scenes', { cache: 'no-store' }));
