// The rating panel of the desktop viewer. Whoever sits at a computer rates the scenes there: a score of
// 0 to 5 stars, a comment and the distance. The distance starts at ×1 in every scene, and the value it
// has when the next scene opens is kept, if it was changed while the scene was in view. Each computer
// exports its ratings to a file; the computer that collects them imports the files, each under the name
// of the person who rated, and shows every rating of the scene in view with the averages.
export const MAX_STARS = 5;

const openKey = 'gaussian-viewer-rating-panel';
const COMMENT_SAVE_MS = 600;

const formatDistance = (value) => `×${value.toFixed(2)}`;
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Scenes opened from the computer are not in the folder and cannot be rated.
const canRate = (item) => !!item && !item.id.startsWith('local:');

async function request(url, body) {
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'The ratings could not be saved.');
  return data;
}

// distance(): the factor the distance slider shows. onShowDistance(factor) sets the slider to a factor
// without counting as a change of this computer's rating.
export function createRatingPanel({ distance, onShowDistance, showToast }) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $('#rating-panel');
  const toggle = $('#rating-button');
  const scoreButtons = [...panel.querySelectorAll('[data-score]')];
  const comment = $('#rating-comment');
  const fileInput = $('#rating-file');
  const dialog = $('#import-dialog');
  const nameInput = $('#import-name');
  let mine = {};
  let imported = [];
  let canImport = false;
  let item = null;
  // Whether the distance was changed, and the comment edited but not yet saved, since the scene opened.
  let distanceTouched = false;
  let commentTimer = null;
  let pendingFile = null;
  let open = true;
  try {
    open = localStorage.getItem(openKey) !== 'closed';
  } catch {}

  const own = () => (canRate(item) ? mine[item.id] ?? null : null);

  // The rating as it is to be saved: what is there, with the changes. A new one takes the distance now.
  function ratingWith(id, changes) {
    return { stars: null, comment: '', distance: Math.round(distance() * 100) / 100, ...mine[id], ...changes, updatedAt: Date.now() };
  }

  async function save(id, changes) {
    // Builds on the saved rating, so the first ones wait for them to arrive.
    await loaded;
    const previous = mine[id];
    const rating = ratingWith(id, changes);
    mine[id] = rating;
    render();
    try {
      const { rating: saved } = await request(`/api/ratings?scene=${encodeURIComponent(id)}`, rating);
      if (mine[id] === rating) {
        if (saved) mine[id] = saved;
        else delete mine[id];
      }
    } catch (error) {
      if (mine[id] === rating) {
        if (previous) mine[id] = previous;
        else delete mine[id];
      }
      showToast(error.message, true);
    }
    render();
  }

  // What changed in the scene in view and is not saved yet: the comment being typed, and the distance.
  function pendingChanges() {
    const changes = {};
    if (commentTimer) changes.comment = comment.value;
    if (distanceTouched) changes.distance = Math.round(distance() * 100) / 100;
    clearTimeout(commentTimer);
    commentTimer = null;
    distanceTouched = false;
    return canRate(item) && Object.keys(changes).length ? changes : null;
  }

  function flush() {
    const changes = pendingChanges();
    return changes ? save(item.id, changes) : Promise.resolve();
  }

  function renderOwn() {
    const rating = own();
    const stars = rating?.stars ?? null;
    for (const button of scoreButtons) {
      const value = Number(button.dataset.score);
      button.classList.toggle('filled', stars !== null && value <= stars && value > 0);
      button.setAttribute('aria-pressed', String(value === stars));
      button.title = value === stars ? 'Clear the score' : `Score ${value} of ${MAX_STARS} (key ${value})`;
    }
    $('#rating-score-value').textContent = stars === null ? 'No score' : `${stars} / ${MAX_STARS}`;
    if (!commentTimer && document.activeElement !== comment) comment.value = rating?.comment ?? '';
    renderDistance();
  }

  function renderDistance() {
    $('#rating-distance-now').textContent = formatDistance(distance());
    const saved = own()?.distance;
    $('#rating-distance-saved').textContent = saved ? `saved ${formatDistance(saved)}` : 'not saved yet';
  }

  // Every imported rating of the scene in view, with the averages.
  function renderAll() {
    const section = $('#rating-all');
    section.hidden = !imported.length;
    if (section.hidden) return;
    const ratings = item ? imported.filter((entry) => entry.ratings[item.id]).map((entry) => ({ name: entry.name, ...entry.ratings[item.id] })) : [];
    const scores = ratings.map((rating) => rating.stars).filter((stars) => stars !== null);
    const distances = ratings.map((rating) => rating.distance).filter((value) => value !== null);
    $('#rating-all-count').textContent = `${ratings.length} of ${imported.length}`;
    $('#rating-average-score').textContent = scores.length ? `${average(scores).toFixed(2)} / ${MAX_STARS}` : '–';
    $('#rating-average-score-detail').textContent = scores.length ? `${plural(scores.length, 'score')} · ${Math.min(...scores)} to ${Math.max(...scores)}` : 'No scores';
    const averageDistance = distances.length ? average(distances) : null;
    $('#rating-average-distance').textContent = averageDistance ? formatDistance(averageDistance) : '–';
    $('#rating-average-distance-detail').textContent = distances.length
      ? `${formatDistance(Math.min(...distances))} to ${formatDistance(Math.max(...distances))}` : 'No distances';
    const showAverage = $('#rating-show-average');
    showAverage.hidden = !averageDistance;
    showAverage.onclick = () => onShowDistance(averageDistance);
    $('#rating-list').replaceChildren(...ratings.map((rating) => {
      const row = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'rating-row-head';
      const name = document.createElement('b');
      name.textContent = rating.name;
      const stars = document.createElement('span');
      stars.className = 'rating-row-stars';
      stars.textContent = rating.stars === null ? '–' : `${'★'.repeat(rating.stars)}${'☆'.repeat(MAX_STARS - rating.stars)}`;
      stars.title = rating.stars === null ? 'No score' : `${rating.stars} of ${MAX_STARS}`;
      head.append(name, stars);
      if (rating.distance) {
        const show = document.createElement('button');
        show.type = 'button';
        show.className = 'rating-row-distance';
        show.textContent = formatDistance(rating.distance);
        show.title = `Show the scene at ${rating.name}'s distance`;
        show.addEventListener('click', () => onShowDistance(rating.distance));
        head.append(show);
      }
      row.append(head);
      if (rating.comment.trim()) {
        const text = document.createElement('p');
        text.textContent = rating.comment;
        row.append(text);
      }
      return row;
    }));
    if (!ratings.length) {
      const empty = document.createElement('li');
      empty.className = 'rating-note';
      empty.textContent = 'No imported ratings for this scene.';
      $('#rating-list').append(empty);
    }
  }

  function renderFiles() {
    const count = Object.keys(mine).length;
    $('#rating-progress').textContent = `${plural(count, 'scene')} rated here`;
    $('#rating-import').hidden = !canImport;
    const list = $('#rating-imports');
    list.hidden = !imported.length;
    $('#rating-imports-count').textContent = imported.length;
    $('#rating-import-list').replaceChildren(...imported.map((entry) => {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = entry.name;
      const detail = document.createElement('small');
      detail.textContent = `${plural(Object.keys(entry.ratings).length, 'scene')}${entry.computer ? ` · ${entry.computer}` : ''}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = `Remove the ratings of ${entry.name}`;
      remove.hidden = !canImport;
      remove.addEventListener('click', () => void removeImport(entry.name));
      row.append(name, detail, remove);
      return row;
    }));
  }

  function render() {
    panel.hidden = !open || !item;
    toggle.hidden = !item;
    toggle.setAttribute('aria-pressed', String(open));
    $('#rating-own').hidden = !canRate(item);
    $('#rating-local').hidden = !item || canRate(item);
    if (panel.hidden) return;
    renderOwn();
    renderAll();
    renderFiles();
  }

  async function load() {
    try {
      ({ mine, imported, canImport } = await request('/api/ratings'));
    } catch (error) {
      showToast(error.message, true);
    }
    render();
  }

  function setScore(value) {
    if (!canRate(item)) return;
    void save(item.id, { ...pendingChanges(), stars: own()?.stars === value ? null : value });
  }

  async function exportRatings() {
    await flush();
    const link = document.createElement('a');
    link.href = '/api/ratings/export';
    link.download = '';
    link.click();
  }

  async function chooseImport(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      data = null;
    }
    if (data?.format !== 'gaussian-viewer-ratings' || !data.ratings || typeof data.ratings !== 'object') {
      showToast(`${file.name} is not a ratings file exported from the viewer.`, true);
      return;
    }
    pendingFile = data;
    const count = Object.keys(data.ratings).length;
    $('#import-file').textContent = `${file.name} · ${plural(count, 'scene')}${data.computer ? ` · from ${data.computer}` : ''}`;
    nameInput.value = '';
    updateImportNote();
    dialog.showModal();
    nameInput.focus();
  }

  function updateImportNote() {
    const name = nameInput.value.trim();
    const existing = imported.find((entry) => entry.name === name);
    const note = $('#import-replace');
    note.hidden = !existing;
    if (existing) note.textContent = `Replaces the ${plural(Object.keys(existing.ratings).length, 'rating')} imported for ${name} before.`;
  }

  async function importFile(name, file) {
    try {
      const { count } = await request('/api/ratings/import', { name, file });
      showToast(`Imported ${plural(count, 'rating')} for ${name}.`);
    } catch (error) {
      showToast(error.message, true);
    }
    await load();
  }

  async function removeImport(name) {
    if (!confirm(`Remove the imported ratings of ${name}?`)) return;
    try {
      await request('/api/ratings/remove', { name });
    } catch (error) {
      showToast(error.message, true);
    }
    await load();
  }

  for (const button of scoreButtons) button.addEventListener('click', () => setScore(Number(button.dataset.score)));
  comment.addEventListener('input', () => {
    clearTimeout(commentTimer);
    commentTimer = setTimeout(() => void flush(), COMMENT_SAVE_MS);
  });
  comment.addEventListener('blur', () => { if (commentTimer) void flush(); });
  // Keys typed into the comment stay there.
  comment.addEventListener('keydown', (event) => event.stopPropagation());
  toggle.addEventListener('click', () => {
    open = !open;
    try {
      localStorage.setItem(openKey, open ? 'open' : 'closed');
    } catch {}
    render();
  });
  $('#rating-export').addEventListener('click', () => void exportRatings());
  $('#rating-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files ?? [];
    fileInput.value = '';
    if (file) void chooseImport(file);
  });
  nameInput.addEventListener('input', updateImportNote);
  // Import, or Enter in the name, submits the form, which closes the dialog itself. Cancel and Escape
  // leave the file unused.
  dialog.querySelector('form').addEventListener('submit', () => {
    const name = nameInput.value.trim();
    if (name && pendingFile) void importFile(name, pendingFile);
    pendingFile = null;
  });
  $('#import-cancel').addEventListener('click', () => {
    pendingFile = null;
    dialog.close();
  });
  // Closing or leaving the page keeps what changed in the scene in view.
  window.addEventListener('pagehide', () => {
    const changes = pendingChanges();
    if (!changes) return;
    const body = new Blob([JSON.stringify(ratingWith(item.id, changes))], { type: 'application/json' });
    navigator.sendBeacon(`/api/ratings?scene=${encodeURIComponent(item.id)}`, body);
  });

  const loaded = load();

  return {
    // The scene now in view, or null. Call leave() before, while the scene before is still in view.
    setScene(next) {
      item = next;
      distanceTouched = false;
      clearTimeout(commentTimer);
      commentTimer = null;
      comment.value = own()?.comment ?? '';
      render();
    },
    // Keeps the distance and comment of the scene in view, before another one opens.
    leave() {
      void flush();
    },
    // The user changed the distance.
    distanceChanged() {
      distanceTouched = true;
      if (!panel.hidden) renderDistance();
    },
    // The distance changed some other way, for showing it.
    showDistance() {
      if (!panel.hidden) renderDistance();
    },
    // Keys 0 to 5.
    rate: setScore,
  };
}
