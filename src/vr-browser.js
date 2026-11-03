import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { MAX_RATING, RATING_FILTERS, canRate, filterLabel, passesFilter, saveFilter, savedFilter } from './scene-rating.js';
import { SORT_OPTIONS, saveSort, savedSort, sortOption, sortScenes, sortValue } from './scene-sort.js';

// Headset interface: a scene browser panel and a loading card, both standing in the room. Controllers
// are drawn with a pointer ray and a cursor; the trigger clicks. The stars on a card rate that scene.
// While a scene is in view, a short pull of the right trigger brings up a rating card for it, and
// changing the distance with the right stick shows its value on a card below the line of sight.
//
// renderer is three.js's WebGLRenderer, or the WebGPU XR session's stand-in for it (webgpu-xr.js),
// which sets renderer.xr.controllerModels and renderer.xr.quadLayers to false: Quest Browser does not
// show quad layers behind a WebGPU projection layer, so panel and card stay meshes there.
//
// Where the headset supports WebXR layers, panel and card are native quad layers. The headset
// composites those at full display resolution, so text stays sharp even though the splats render at a
// reduced resolution with foveation. The layers sit behind the rendered image; their meshes punch a
// transparent hole into it, so controllers, rays and highlights still appear on top.

const ACCENT = '#6ea6d6';
const STAR_COLOR = '#f2c94c';
// One canvas pixel is one millimetre on the panel.
// 2.4 by 1.5 m keeps the 16:10 shape the panel always had.
const PANEL = { width: 2.4, height: 1.5, distance: 1.5, drop: 0.12 };
const PANEL_CANVAS = { width: 2400, height: 1500 };
const MARGIN = 56;
const COLUMNS = 3;
const GAP = 28;
// The strip right of the cards that holds the scrollbar; all of it grabs the bar.
const SCROLL_STRIP = 96;
// The scrolling part of the panel, in canvas pixels.
const CONTENT = { x: MARGIN, y: 252, width: PANEL_CANVAS.width - MARGIN - SCROLL_STRIP, height: PANEL_CANVAS.height - 252 - 36 };
const CARD_WIDTH = (CONTENT.width - GAP * (COLUMNS - 1)) / COLUMNS;
// Pictures keep the same proportions whatever the number of columns; the name sits below.
const THUMB_HEIGHT = Math.round(CARD_WIDTH * 0.59);
const CARD_HEIGHT = THUMB_HEIGHT + 72;
const ROW_HEIGHT = CARD_HEIGHT + GAP;
const HEADING_HEIGHT = 72;
const EDGE_FADE = 32;
const SCROLLBAR = { x: CONTENT.x + CONTENT.width + (SCROLL_STRIP - 16) / 2, width: 16, minLength: 80 };
const SCROLLBAR_HIT = { x: CONTENT.x + CONTENT.width, y: CONTENT.y, width: SCROLL_STRIP, height: CONTENT.height };
// The stars on a card's picture, in its bottom right corner; each one is a button.
const CARD_STAR = { width: 58, height: 58, inset: 10 };
// Two header rows: title and leaving at the top, what to show and in which order below.
const ROW_1 = { y: 28, height: 84 };
const ROW_2 = { y: 140, height: 84 };
const CLOSE_BUTTON = { x: PANEL_CANVAS.width - MARGIN - 100, ...ROW_1, width: 100, action: 'close', label: '✕' };
const EXIT_BUTTON = { x: CLOSE_BUTTON.x - 20 - 230, ...ROW_1, width: 230, action: 'exit', label: 'Exit VR' };
const FILTER_BUTTONS = RATING_FILTERS.reduce((buttons, option) => {
  const previous = buttons.at(-1);
  const width = option.stars ? 76 + option.stars * 40 : option.label === 'All' ? 140 : 210;
  return [...buttons, { x: previous ? previous.x + previous.width : MARGIN, ...ROW_2, width, action: 'filter', key: option.value, option }];
}, []);
const SORT_BUTTON = { x: PANEL_CANVAS.width - MARGIN - 420, ...ROW_2, width: 420, action: 'sort-menu' };
const SORT_ITEMS = SORT_OPTIONS.map((option, index) => ({
  x: SORT_BUTTON.x, y: SORT_BUTTON.y + SORT_BUTTON.height + 8 + index * 80, width: SORT_BUTTON.width, height: 80,
  action: 'sort', key: sortValue(option), option,
}));
// Scrolling, in canvas pixels: full stick deflection, how fast a fling dies down, and how far a
// press has to move before it scrolls instead of clicking.
const SCROLL_SPEED = 1800;
const SCROLL_FRICTION = 4;
const DRAG_THRESHOLD = 14;
// Close to eye level, clear of the FPS readout below and to the left.
const LOADER = { width: 0.44, height: 0.13, distance: 1.1, drop: 0.02 };
const LOADER_CANVAS = { width: 960, height: 284 };
const LOADER_THUMB = { x: 22, y: 22, width: 384, height: 240 };
const LOADER_TEXT_X = 436;
const LOADER_TEXT_WIDTH = 494;
// The rating card, below eye level. The left trigger lifts the user and the right one runs, so only a
// short pull of the right trigger brings it up; it goes again soon after a rating, or after a while.
const RATER = { width: 0.5, height: 0.17, distance: 1, drop: 0.22 };
const RATER_CANVAS = { width: 1000, height: 340 };
const RATER_STARS = Array.from({ length: MAX_RATING }, (_, index) => ({
  x: RATER_CANVAS.width / 2 + (index - (MAX_RATING - 1) / 2) * 180 - 85, y: 150, width: 170, height: 170,
  action: 'rate', value: index + 1,
}));
const RATER_CLICK_MS = 450;
const RATER_AFTER_RATING_MS = 900;
const RATER_IDLE_MS = 8000;
// The distance card: the stretch factor and where it sits in the stick's range. It stays up a moment
// after the stick lets go.
const DISTANCE = { width: 0.4, height: 0.1, distance: 1, drop: 0.36 };
const DISTANCE_CANVAS = { width: 800, height: 200 };
const DISTANCE_TRACK = { x: 260, y: 104, width: 500, height: 14 };
const DISTANCE_SHOW_MS = 1500;
// Redraws of the loading and distance cards are capped, since each one uploads the whole canvas.
const LOADER_REDRAW_MS = 50;
const LOADER_ERROR_MS = 4000;

const RAY_LENGTH = 1.5;
const CURSOR_RADIUS = 0.006;
const UI_ORDER = 1e6 + 10;
// Quest Browser reads a quad layer's width and height as half extents; three.js sizes its layers the same way.
const QUAD_LAYER_SCALE = 0.5;

function fitText(context, text, width) {
  if (context.measureText(text).width <= width) return text;
  let end = text.length;
  while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > width) end -= 1;
  return `${text.slice(0, end)}…`;
}

function drawCover(context, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  context.drawImage(image, (image.naturalWidth - sourceWidth) / 2, (image.naturalHeight - sourceHeight) / 2,
    sourceWidth, sourceHeight, x, y, width, height);
}

function drawPlaceholder(context, x, y, width, height) {
  const gradient = context.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, '#3e3e3e');
  gradient.addColorStop(1, '#222');
  context.fillStyle = gradient;
  context.fillRect(x, y, width, height);
}

// A five-pointed star around (x, y), filled or as an outline.
function drawStar(context, x, y, radius, filled, color = STAR_COLOR) {
  context.beginPath();
  for (let point = 0; point < 10; point += 1) {
    const angle = -Math.PI / 2 + (point * Math.PI) / 5;
    const length = point % 2 ? radius * 0.45 : radius;
    context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
  }
  context.closePath();
  if (filled) {
    context.fillStyle = color;
    context.fill();
  } else {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.stroke();
  }
}

function drawButton(context, { x, y, width, height, label, stars = 0 }, active = false) {
  context.fillStyle = active ? '#2e4352' : '#262626';
  context.fillRect(x, y, width, height);
  context.strokeStyle = active ? ACCENT : '#ffffff30';
  context.lineWidth = 2;
  context.strokeRect(x + 1, y + 1, width - 2, height - 2);
  if (stars) {
    for (let index = 0; index < stars; index += 1) drawStar(context, x + width / 2 + (index - (stars - 1) / 2) * 40, y + height / 2, 17, true);
    return;
  }
  context.fillStyle = '#e8e8e8';
  context.font = '36px system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText(label, x + width / 2, y + height / 2);
  context.textAlign = 'left';
}

// Where star number value (1 to 3) of a card sits, in canvas pixels; y is the card's top on the panel.
function cardStar(x, y, value) {
  return {
    x: x + CARD_WIDTH - CARD_STAR.inset - (MAX_RATING - value + 1) * CARD_STAR.width,
    y: y + THUMB_HEIGHT - CARD_STAR.inset - CARD_STAR.height,
    width: CARD_STAR.width,
    height: CARD_STAR.height,
  };
}

// Folder of a scene as the 2D browser titles it; scenes in the top folder have none.
function folderOf(item) {
  if (item.id.startsWith('local:')) return 'Opened files';
  const slash = item.id.lastIndexOf('/');
  return slash < 0 ? '' : item.id.slice(0, slash).split('/').join(' / ');
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

export function createVrSceneBrowser({ renderer, scene, rig, onOpenChange, onSelect, onRate, onExit, onOrderChange }) {
  let items = [];
  let activeId = null;
  // Card and heading positions in content pixels, laid out once per scene list.
  let layout = { entries: [], height: 0 };
  let scroll = 0;
  let sort = savedSort();
  let filter = savedFilter();
  let sortMenuOpen = false;
  let shownCount = 0;
  let scrollStick = 0;
  let fling = 0;
  let panelStale = false;
  let lastUpdate = 0;
  let open = false;
  let presenting = false;
  let loading = null;
  let loaderKey = '';
  let loaderDrawnAt = 0;
  let loaderErrorTimer = null;
  let raterShown = false;
  let raterStale = false;
  let raterHideAt = 0;
  let raterRated = false;
  // { value, min, max } of the depth stretch, and until when the card shows it.
  let distanceState = null;
  let distanceUntil = 0;
  let distanceKey = '';
  let distanceDrawnAt = 0;
  // Thumbnails stay decoded once loaded, so turning back to a page is instant.
  const previews = new Map();
  const raycaster = new THREE.Raycaster();
  const headPosition = new THREE.Vector3();
  const headDirection = new THREE.Vector3();
  const layerMatrix = new THREE.Matrix4();
  const layerPosition = new THREE.Vector3();
  const layerQuaternion = new THREE.Quaternion();
  const layerScale = new THREE.Vector3();
  let native = null;

  // Writes zero colour and alpha, so the quad layer behind shows through. It still tests depth, so the
  // controller models in front of it stay visible; the splats write no depth and are cut away.
  const holePunch = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.ZeroFactor,
  });

  // A canvas drawn as a plane in the scene, or as a native quad layer when the headset has them.
  function surface(canvasSize, size) {
    const canvas = Object.assign(document.createElement('canvas'), canvasSize);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.width, size.height), material);
    mesh.renderOrder = UI_ORDER;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { canvas, context: canvas.getContext('2d'), texture, material, mesh, size, layer: null, dirty: true };
  }

  function changed(target) {
    target.texture.needsUpdate = true;
    target.dirty = true;
  }

  // Back to front: layers later in the list cover earlier ones.
  const panel = surface(PANEL_CANVAS, PANEL);
  const loader = surface(LOADER_CANVAS, LOADER);
  const rater = surface(RATER_CANVAS, RATER);
  const distanceCard = surface(DISTANCE_CANVAS, DISTANCE);
  const surfaces = [panel, loader, rater, distanceCard];

  const highlight = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  highlight.renderOrder = UI_ORDER + 1;
  highlight.visible = false;
  panel.mesh.add(highlight);

  // Controller models come from the WebXR input profiles; they are lit, the splats are not affected.
  const modelFactory = renderer.xr.controllerModels === false ? null : new XRControllerModelFactory();
  if (modelFactory) scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 3));

  // A tapered beam, thin at the far end, reaching 1 m along -Z before scaling.
  const rayGeometry = new THREE.CylinderGeometry(0.0011, 0.0024, 1, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
  const cursorGeometry = new THREE.CircleGeometry(CURSOR_RADIUS, 32);
  const cursorRingGeometry = new THREE.RingGeometry(CURSOR_RADIUS, CURSOR_RADIUS * 1.6, 32);
  const pointers = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index);
    const ray = new THREE.Mesh(rayGeometry, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthTest: false, depthWrite: false,
    }));
    ray.renderOrder = UI_ORDER + 2;
    ray.frustumCulled = false;
    controller.add(ray);
    controller.visible = false;
    rig.add(controller);

    const grip = renderer.xr.getControllerGrip(index);
    if (modelFactory) grip.add(modelFactory.createControllerModel(grip));
    rig.add(grip);

    const cursor = new THREE.Group();
    const dot = new THREE.Mesh(cursorGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true }));
    const ring = new THREE.Mesh(cursorRingGeometry, new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false, transparent: true }));
    for (const part of [dot, ring]) {
      part.renderOrder = UI_ORDER + 3;
      part.frustumCulled = false;
    }
    cursor.add(dot, ring);
    cursor.visible = false;
    scene.add(cursor);

    const pointer = {
      controller, ray, cursor, source: null, connected: false, target: null,
      pressStarted: false, pressed: false, released: false, press: null,
    };
    controller.addEventListener('connected', (event) => {
      pointer.source = event.data;
      pointer.connected = true;
      controller.visible = true;
    });
    controller.addEventListener('disconnected', () => {
      pointer.connected = false;
      pointer.source = null;
      controller.visible = false;
      cursor.visible = false;
    });
    // Press and release are handled apart, so a press can turn into a drag that scrolls the panel.
    controller.addEventListener('selectstart', () => {
      pointer.pressStarted = true;
      pointer.pressed = true;
    });
    controller.addEventListener('selectend', () => {
      pointer.pressed = false;
      pointer.released = true;
    });
    return pointer;
  });

  function pulse(pointer, intensity, milliseconds) {
    try {
      pointer.source?.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, milliseconds);
    } catch {}
  }

  // Folders in the order they come, scenes of the chosen star class sorted within each.
  function layoutScenes() {
    const folders = new Map();
    const shown = items.filter((item) => passesFilter(item, filter));
    shownCount = shown.length;
    for (const item of shown) {
      const group = folderOf(item);
      if (!folders.has(group)) folders.set(group, []);
      folders.get(group).push(item);
    }
    const entries = [];
    let y = 0;
    for (const [group, scenes] of folders) {
      if (group) {
        entries.push({ type: 'heading', y, height: HEADING_HEIGHT, text: group });
        y += HEADING_HEIGHT;
      }
      sortScenes(scenes, sort).forEach((item, index) => {
        const column = index % COLUMNS;
        entries.push({ type: 'card', y, height: CARD_HEIGHT, x: CONTENT.x + column * (CARD_WIDTH + GAP), item });
        if (column === COLUMNS - 1 || index === scenes.length - 1) y += ROW_HEIGHT;
      });
    }
    layout = { entries, height: Math.max(0, y - GAP) };
  }

  const maxScroll = () => Math.max(0, layout.height - CONTENT.height);
  // Where the scrollbar's thumb sits and how long it is, in canvas pixels.
  function scrollThumb() {
    const length = Math.max(SCROLLBAR.minLength, CONTENT.height * (CONTENT.height / Math.max(layout.height, CONTENT.height)));
    return { y: CONTENT.y + (CONTENT.height - length) * (maxScroll() ? scroll / maxScroll() : 0), length };
  }
  const visibleEntries = (margin = 0) => layout.entries.filter((entry) =>
    entry.y + entry.height > scroll - margin && entry.y < scroll + CONTENT.height + margin);

  function setScroll(value) {
    const clamped = THREE.MathUtils.clamp(value, 0, maxScroll());
    // A fling stops at either end of the list.
    if (clamped !== value) fling = 0;
    if (Math.abs(clamped - scroll) < 0.01) return;
    scroll = clamped;
    panelStale = true;
  }

  function scrollToActive() {
    const entry = layout.entries.find((candidate) => candidate.item?.id === activeId);
    scroll = 0;
    setScroll(entry ? entry.y - (CONTENT.height - CARD_HEIGHT) / 2 : 0);
  }

  function previewFor(item) {
    const url = item?.thumbUrl || item?.imageUrl;
    if (!url) return null;
    let entry = previews.get(url);
    if (!entry) {
      const image = new Image();
      image.src = url;
      entry = { image, loaded: false, failed: false };
      entry.ready = image.decode().then(() => { entry.loaded = true; }, () => { entry.failed = true; });
      previews.set(url, entry);
    }
    return entry;
  }

  function drawPanel() {
    const { context } = panel;
    const { width, height } = PANEL_CANVAS;
    context.fillStyle = '#171717';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#ffffff24';
    context.lineWidth = 3;
    context.strokeRect(1.5, 1.5, width - 3, height - 3);
    context.textBaseline = 'middle';
    context.fillStyle = '#f2f2f2';
    context.font = '600 60px system-ui, sans-serif';
    context.fillText('Scenes', MARGIN, ROW_1.y + ROW_1.height / 2);
    const titleWidth = context.measureText('Scenes').width;
    context.fillStyle = '#8a8a8a';
    context.font = '32px ui-monospace, monospace';
    context.fillText(filter === 'all' ? `${items.length} ${items.length === 1 ? 'scene' : 'scenes'}` : `${shownCount} of ${items.length} scenes`,
      MARGIN + titleWidth + 32, ROW_1.y + ROW_1.height / 2 + 4);
    for (const button of FILTER_BUTTONS) {
      drawButton(context, { ...button, label: button.option.label, stars: button.option.stars }, button.key === filter);
    }
    drawButton(context, EXIT_BUTTON);
    drawButton(context, CLOSE_BUTTON);

    const pending = [];
    context.save();
    context.beginPath();
    context.rect(CONTENT.x, CONTENT.y, CONTENT.width, CONTENT.height);
    context.clip();
    for (const entry of visibleEntries()) {
      const y = CONTENT.y + entry.y - scroll;
      if (entry.type === 'heading') {
        context.fillStyle = '#9a9a9a';
        context.font = '600 26px ui-monospace, monospace';
        context.fillText(fitText(context, entry.text.toUpperCase(), CONTENT.width), CONTENT.x, y + HEADING_HEIGHT / 2);
        continue;
      }
      const { x, item } = entry;
      const active = item.id === activeId;
      context.fillStyle = '#222';
      context.fillRect(x, y, CARD_WIDTH, CARD_HEIGHT);
      const preview = previewFor(item);
      if (preview?.loaded) {
        drawCover(context, preview.image, x, y, CARD_WIDTH, THUMB_HEIGHT);
      } else {
        drawPlaceholder(context, x, y, CARD_WIDTH, THUMB_HEIGHT);
        if (preview && !preview.failed) pending.push(preview.ready);
      }
      if (canRate(item)) drawCardStars(context, x, y, item.rating ?? 0);
      context.fillStyle = active ? '#fff' : '#d4d4d4';
      context.font = '32px system-ui, sans-serif';
      context.fillText(fitText(context, item.name, CARD_WIDTH - 40), x + 20, y + THUMB_HEIGHT + (CARD_HEIGHT - THUMB_HEIGHT) / 2);
      if (active) {
        context.strokeStyle = ACCENT;
        context.lineWidth = 6;
        context.strokeRect(x + 3, y + 3, CARD_WIDTH - 6, CARD_HEIGHT - 6);
      }
    }
    if (!layout.entries.length) {
      context.fillStyle = '#929292';
      context.font = '36px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText(items.length ? `There are no ${filterLabel(filter)} yet.` : 'The scene folder has no splat files yet.',
        CONTENT.x + CONTENT.width / 2, CONTENT.y + 140);
      context.textAlign = 'left';
    }
    context.restore();

    // Soft edges where cards scroll in and out.
    for (const [edge, from, to] of [[CONTENT.y, '#171717', '#17171700'], [CONTENT.y + CONTENT.height - EDGE_FADE, '#17171700', '#171717']]) {
      const gradient = context.createLinearGradient(0, edge, 0, edge + EDGE_FADE);
      gradient.addColorStop(0, from);
      gradient.addColorStop(1, to);
      context.fillStyle = gradient;
      context.fillRect(CONTENT.x, edge, CONTENT.width, EDGE_FADE);
    }
    if (maxScroll() > 0) {
      const thumb = scrollThumb();
      context.fillStyle = '#ffffff12';
      roundedBar(context, SCROLLBAR.x, CONTENT.y, SCROLLBAR.width, CONTENT.height);
      context.fillStyle = pointers.some((pointer) => pointer.press?.scrollbar) ? ACCENT : '#ffffff66';
      roundedBar(context, SCROLLBAR.x, thumb.y, SCROLLBAR.width, thumb.length);
    }
    drawSortMenu(context);
    changed(panel);

    // Redraw when the visible thumbnails are in, and start fetching the ones just below meanwhile.
    if (pending.length) Promise.all(pending).then(() => { panelStale = true; });
    for (const entry of visibleEntries(CONTENT.height)) if (entry.item) previewFor(entry.item);
  }

  // A dark strip behind the stars keeps them readable on any picture; unrated scenes show outlines.
  function drawCardStars(context, x, y, rating) {
    const first = cardStar(x, y, 1);
    context.fillStyle = '#000000a0';
    context.beginPath();
    context.roundRect(first.x - 6, first.y, MAX_RATING * CARD_STAR.width + 12, CARD_STAR.height, CARD_STAR.height / 2);
    context.fill();
    for (let value = 1; value <= MAX_RATING; value += 1) {
      const star = cardStar(x, y, value);
      drawStar(context, star.x + star.width / 2, star.y + star.height / 2, 21, value <= rating, value <= rating ? STAR_COLOR : '#ffffffb0');
    }
  }

  // The sort button, and the list of orders under it while it is open.
  function drawSortMenu(context) {
    drawButton(context, { ...SORT_BUTTON, label: '' }, sortMenuOpen);
    context.fillStyle = '#e8e8e8';
    context.font = '34px system-ui, sans-serif';
    context.fillText(fitText(context, `Sort: ${sortOption(sort).label}`, SORT_BUTTON.width - 90), SORT_BUTTON.x + 28, SORT_BUTTON.y + SORT_BUTTON.height / 2);
    // A chevron, pointing up while the list is open.
    const chevronX = SORT_BUTTON.x + SORT_BUTTON.width - 42;
    const chevronY = SORT_BUTTON.y + SORT_BUTTON.height / 2;
    const tip = sortMenuOpen ? -7 : 7;
    context.strokeStyle = '#e8e8e8';
    context.lineWidth = 3.5;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(chevronX - 13, chevronY - tip);
    context.lineTo(chevronX, chevronY + tip);
    context.lineTo(chevronX + 13, chevronY - tip);
    context.stroke();
    context.lineCap = 'butt';
    if (!sortMenuOpen) return;
    const first = SORT_ITEMS[0];
    const last = SORT_ITEMS.at(-1);
    context.fillStyle = '#00000080';
    context.fillRect(first.x - 4, first.y - 4, first.width + 16, last.y + last.height - first.y + 16);
    context.fillStyle = '#202020';
    context.fillRect(first.x, first.y, first.width, last.y + last.height - first.y);
    context.strokeStyle = '#ffffff30';
    context.lineWidth = 2;
    context.strokeRect(first.x + 1, first.y + 1, first.width - 2, last.y + last.height - first.y - 2);
    for (const entry of SORT_ITEMS) {
      const chosen = entry.key === sortValue(sort);
      if (chosen) {
        context.fillStyle = '#2e4352';
        context.fillRect(entry.x + 2, entry.y, entry.width - 4, entry.height);
        context.fillStyle = ACCENT;
        context.fillRect(entry.x + 2, entry.y, 6, entry.height);
      }
      context.fillStyle = chosen ? '#fff' : '#d4d4d4';
      context.font = '34px system-ui, sans-serif';
      context.fillText(entry.option.label, entry.x + 32, entry.y + entry.height / 2);
    }
  }

  const activeItem = () => items.find((item) => item.id === activeId) ?? null;

  function drawRater() {
    const { context } = rater;
    const { width, height } = RATER_CANVAS;
    const item = activeItem();
    const rating = item?.rating ?? 0;
    context.fillStyle = '#181818';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#ffffff26';
    context.lineWidth = 3;
    context.strokeRect(1.5, 1.5, width - 3, height - 3);
    context.textBaseline = 'middle';
    context.fillStyle = ACCENT;
    context.font = '600 22px system-ui, sans-serif';
    context.letterSpacing = '3px';
    context.fillText('RATE THIS SCENE', 40, 50);
    context.letterSpacing = '0px';
    context.fillStyle = '#f4f4f4';
    context.font = '600 38px system-ui, sans-serif';
    context.fillText(fitText(context, item?.name ?? '', width - 80), 40, 100);
    for (const star of RATER_STARS) {
      drawStar(context, star.x + star.width / 2, star.y + star.height / 2, 62, star.value <= rating, star.value <= rating ? STAR_COLOR : '#ffffff90');
    }
    changed(rater);
  }

  function setRaterShown(value) {
    raterShown = value && presenting && !open && !loading && canRate(activeItem());
    if (raterShown) {
      raterRated = false;
      placeInFront(rater.mesh, RATER);
      raterHideAt = performance.now() + RATER_IDLE_MS;
      drawRater();
    }
  }

  function updateRater(now) {
    if (raterShown && (now > raterHideAt || open || loading || !canRate(activeItem()))) raterShown = false;
    if (rater.mesh.visible !== raterShown) {
      rater.mesh.visible = raterShown;
      showNativeLayers();
    }
    if (raterShown && raterStale) {
      raterStale = false;
      drawRater();
    }
  }

  // The value shows as the factor on the slider in the page, 1 + stretch.
  function drawDistance(now) {
    const { context } = distanceCard;
    const { width, height } = DISTANCE_CANVAS;
    const { value, min, max } = distanceState;
    const track = DISTANCE_TRACK;
    const fraction = THREE.MathUtils.clamp((value - min) / (max - min || 1), 0, 1);
    context.fillStyle = '#181818';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#ffffff26';
    context.lineWidth = 3;
    context.strokeRect(1.5, 1.5, width - 3, height - 3);
    context.textBaseline = 'middle';
    context.fillStyle = ACCENT;
    context.font = '600 20px system-ui, sans-serif';
    context.letterSpacing = '3px';
    context.fillText('DISTANCE', 32, 44);
    context.letterSpacing = '0px';
    context.fillStyle = '#8a8a8a';
    context.font = '20px system-ui, sans-serif';
    context.textAlign = 'right';
    context.fillText('Right stick: up further, down closer', width - 40, 44);
    context.textAlign = 'left';
    context.fillStyle = '#f4f4f4';
    context.font = '600 60px ui-monospace, monospace';
    context.fillText(`×${(1 + value).toFixed(2)}`, 28, 118);

    context.fillStyle = '#2c2c2c';
    roundedBar(context, track.x, track.y, track.width, track.height);
    const fill = Math.max(track.height, track.width * fraction);
    const gradient = context.createLinearGradient(track.x, 0, track.x + fill, 0);
    gradient.addColorStop(0, '#4f86b8');
    gradient.addColorStop(1, '#8cc4f0');
    context.fillStyle = gradient;
    roundedBar(context, track.x, track.y, fill, track.height);
    // A mark at every whole factor, labelled below.
    context.font = '20px ui-monospace, monospace';
    context.textAlign = 'center';
    for (let factor = Math.ceil(1 + min); factor <= 1 + max; factor += 1) {
      const x = track.x + track.width * ((factor - 1 - min) / (max - min || 1));
      context.fillStyle = '#ffffff60';
      context.fillRect(x - 1, track.y + track.height + 6, 2, 10);
      context.fillStyle = '#9a9a9a';
      context.fillText(`×${factor}`, THREE.MathUtils.clamp(x, track.x + 14, track.x + track.width - 14), track.y + track.height + 38);
    }
    context.textAlign = 'left';
    const knobX = track.x + track.width * fraction;
    context.fillStyle = '#f4f4f4';
    context.beginPath();
    context.arc(knobX, track.y + track.height / 2, 16, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = ACCENT;
    context.lineWidth = 4;
    context.stroke();
    distanceDrawnAt = now;
    changed(distanceCard);
  }

  function updateDistance(now) {
    const visible = presenting && !open && !!distanceState && now < distanceUntil;
    if (distanceCard.mesh.visible !== visible) {
      // Set down in front of the user when the stick starts; it stays there while the head turns.
      if (visible) placeInFront(distanceCard.mesh, DISTANCE);
      distanceCard.mesh.visible = visible;
      distanceKey = '';
      distanceDrawnAt = 0;
      showNativeLayers();
    }
    if (!visible) return;
    const key = (1 + distanceState.value).toFixed(2);
    if (key === distanceKey || now - distanceDrawnAt < LOADER_REDRAW_MS) return;
    distanceKey = key;
    drawDistance(now);
  }

  function roundedBar(context, x, y, width, height) {
    context.beginPath();
    context.roundRect(x, y, width, height, height / 2);
    context.fill();
  }

  function drawLoader(now) {
    const { context } = loader;
    const { width, height } = LOADER_CANVAS;
    const { item, phase, loaded = 0, total = 0, message = '' } = loading;
    const failed = phase === 'error';
    context.fillStyle = '#181818';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = failed ? '#e07b7b88' : '#ffffff26';
    context.lineWidth = 3;
    context.strokeRect(1.5, 1.5, width - 3, height - 3);

    const thumb = LOADER_THUMB;
    const preview = previewFor(item);
    if (preview?.loaded) {
      drawCover(context, preview.image, thumb.x, thumb.y, thumb.width, thumb.height);
    } else {
      drawPlaceholder(context, thumb.x, thumb.y, thumb.width, thumb.height);
      preview?.ready.then(() => { if (loading?.item === item) loaderKey = ''; });
    }
    if (!failed) {
      // Dim the picture until the scene is there.
      context.fillStyle = '#0000004d';
      context.fillRect(thumb.x, thumb.y, thumb.width, thumb.height);
    }

    const x = LOADER_TEXT_X;
    context.textBaseline = 'middle';
    context.fillStyle = failed ? '#e07b7b' : ACCENT;
    context.font = '600 22px system-ui, sans-serif';
    context.letterSpacing = '3px';
    context.fillText(failed ? 'COULD NOT LOAD' : phase === 'prepare' ? 'PREPARING' : 'LOADING SCENE', x, 52);
    context.letterSpacing = '0px';
    context.fillStyle = '#f4f4f4';
    context.font = '600 40px system-ui, sans-serif';
    context.fillText(fitText(context, item?.name ?? '', LOADER_TEXT_WIDTH), x, 102);

    const trackY = 160;
    const trackHeight = 16;
    context.fillStyle = '#2c2c2c';
    roundedBar(context, x, trackY, LOADER_TEXT_WIDTH, trackHeight);
    if (failed) {
      context.fillStyle = '#e07b7b';
      roundedBar(context, x, trackY, LOADER_TEXT_WIDTH, trackHeight);
    } else if (phase === 'prepare' || !total) {
      // No progress is known here: a segment sweeps along the track.
      const segment = LOADER_TEXT_WIDTH * 0.32;
      const travel = ((now / 1400) % 1) * (LOADER_TEXT_WIDTH + segment) - segment;
      context.save();
      context.beginPath();
      context.roundRect(x, trackY, LOADER_TEXT_WIDTH, trackHeight, trackHeight / 2);
      context.clip();
      const gradient = context.createLinearGradient(x + travel, 0, x + travel + segment, 0);
      gradient.addColorStop(0, '#6ea6d600');
      gradient.addColorStop(0.5, ACCENT);
      gradient.addColorStop(1, '#6ea6d600');
      context.fillStyle = gradient;
      context.fillRect(x + travel, trackY, segment, trackHeight);
      context.restore();
    } else {
      const fill = Math.max(trackHeight, LOADER_TEXT_WIDTH * Math.min(1, loaded / total));
      const gradient = context.createLinearGradient(x, 0, x + fill, 0);
      gradient.addColorStop(0, '#4f86b8');
      gradient.addColorStop(1, '#8cc4f0');
      context.fillStyle = gradient;
      roundedBar(context, x, trackY, fill, trackHeight);
    }

    context.font = '26px system-ui, sans-serif';
    context.fillStyle = failed ? '#e0b0b0' : '#9a9a9a';
    const detail = failed ? message
      : phase === 'prepare' ? 'Building detail levels …'
        : total ? `${formatMegabytes(loaded)} of ${formatMegabytes(total)}` : 'Connecting …';
    context.fillText(fitText(context, detail, LOADER_TEXT_WIDTH - (phase === 'download' && total ? 110 : 0)), x, 226);
    if (phase === 'download' && total) {
      context.fillStyle = '#f4f4f4';
      context.font = '600 32px system-ui, sans-serif';
      context.textAlign = 'right';
      context.fillText(`${Math.min(100, Math.floor((loaded / total) * 100))}%`, x + LOADER_TEXT_WIDTH, 226);
      context.textAlign = 'left';
    }
    loaderDrawnAt = now;
    changed(loader);
  }

  function updateLoader(now) {
    const visible = presenting && !!loading;
    if (loader.mesh.visible !== visible) {
      // Set down in front of the user when loading starts; it stays there while the head turns.
      if (visible) placeInFront(loader.mesh, LOADER);
      loader.mesh.visible = visible;
      loaderKey = '';
      loaderDrawnAt = 0;
      showNativeLayers();
    }
    if (!visible) return;
    const percent = loading.total ? Math.floor((loading.loaded / loading.total) * 200) : 0;
    const key = `${loading.item?.id}|${loading.phase}|${percent}|${loading.message ?? ''}`;
    const animated = loading.phase === 'prepare' || (loading.phase === 'download' && !loading.total);
    if (now - loaderDrawnAt < LOADER_REDRAW_MS || (key === loaderKey && !animated)) return;
    loaderKey = key;
    drawLoader(now);
  }

  function startNativeLayers() {
    const session = renderer.xr.getSession();
    if (renderer.xr.quadLayers === false) return;
    if (!session?.enabledFeatures?.includes('layers') || typeof XRWebGLBinding === 'undefined') return;
    try {
      // three.js renders splats, controllers and rays into this layer. Taken from three.js itself: the session's
      // render state only lists it from the first XR frame on, which comes after 'sessionstart'.
      const projection = renderer.xr.getBaseLayer();
      if (typeof XRProjectionLayer === 'undefined' || !(projection instanceof XRProjectionLayer)) return;
      const binding = renderer.xr.getBinding();
      native = { session, binding, projection: [projection], shown: null };
      for (const target of surfaces) {
        target.layer = binding.createQuadLayer({
          space: renderer.xr.getReferenceSpace(),
          viewPixelWidth: target.canvas.width,
          viewPixelHeight: target.canvas.height,
          layout: 'mono',
          clearOnAccess: false,
          width: target.size.width * QUAD_LAYER_SCALE,
          height: target.size.height * QUAD_LAYER_SCALE,
        });
        target.mesh.material = holePunch;
      }
      showNativeLayers();
    } catch (error) {
      console.warn('WebXR quad layers are not available, the interface falls back to meshes.', error);
      stopNativeLayers();
    }
  }

  function stopNativeLayers() {
    for (const target of surfaces) {
      target.mesh.material = target.material;
      try {
        target.layer?.destroy();
      } catch {}
      target.layer = null;
    }
    native = null;
  }

  // Only visible layers may be in the list: behind the splats' transparent background they would show through.
  function showNativeLayers() {
    if (!native) return;
    const shown = surfaces.map((target) => target.mesh.visible).join();
    if (shown === native.shown) return;
    native.shown = shown;
    const layers = [];
    for (const target of surfaces) {
      if (!target.mesh.visible) continue;
      target.dirty = true;
      layers.push(target.layer);
    }
    native.session.updateRenderState({ layers: [...layers, ...native.projection] });
  }

  // Copies a canvas into the layer's texture. Must run inside an XR frame.
  function uploadLayer(target) {
    const gl = renderer.getContext();
    try {
      const { colorTexture } = native.binding.getSubImage(target.layer, renderer.xr.getFrame());
      gl.bindTexture(gl.TEXTURE_2D, colorTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, target.canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, null);
      target.dirty = false;
    } catch {
      // A layer added this frame becomes drawable from the next one.
    } finally {
      renderer.resetState();
    }
  }

  function updateNativeLayers() {
    for (const target of surfaces) {
      if (!target.mesh.visible) continue;
      // The meshes live in the scene, the layers in the XR reference space, which the rig carries around.
      target.mesh.updateMatrixWorld();
      layerMatrix.copy(rig.matrixWorld).invert().multiply(target.mesh.matrixWorld).decompose(layerPosition, layerQuaternion, layerScale);
      target.layer.transform = new XRRigidTransform(layerPosition, layerQuaternion);
      if (target.dirty || target.layer.needsRedraw) uploadLayer(target);
    }
  }

  const inside = (rect, x, y) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

  // While the sort list is open it takes every click: one on an order chooses it, any other closes the list.
  function regionAt(x, y) {
    if (sortMenuOpen) return [SORT_BUTTON, ...SORT_ITEMS].find((entry) => inside(entry, x, y)) ?? null;
    if (inside(CLOSE_BUTTON, x, y)) return CLOSE_BUTTON;
    if (inside(EXIT_BUTTON, x, y)) return EXIT_BUTTON;
    if (inside(SORT_BUTTON, x, y)) return SORT_BUTTON;
    const filterButton = FILTER_BUTTONS.find((button) => inside(button, x, y));
    if (filterButton) return filterButton;
    if (inside(SCROLLBAR_HIT, x, y)) return scrollbarRegion();
    if (!inside(CONTENT, x, y)) return null;
    const contentY = y - CONTENT.y + scroll;
    const entry = layout.entries.find((candidate) => candidate.type === 'card'
      && x >= candidate.x && x <= candidate.x + CARD_WIDTH && contentY >= candidate.y && contentY <= candidate.y + CARD_HEIGHT);
    if (!entry) return null;
    // Cards cut off at the edge of the scrolling area only count where they show.
    const clip = (rect) => {
      const top = Math.max(CONTENT.y, rect.y);
      const bottom = Math.min(CONTENT.y + CONTENT.height, rect.y + rect.height);
      return bottom > top ? { ...rect, y: top, height: bottom - top } : null;
    };
    const cardY = CONTENT.y + entry.y - scroll;
    if (canRate(entry.item)) {
      for (let value = 1; value <= MAX_RATING; value += 1) {
        const star = clip(cardStar(entry.x, cardY, value));
        if (star && inside(star, x, y)) return { ...star, action: 'rate', item: entry.item, value };
      }
    }
    return { ...clip({ x: entry.x, y: cardY, width: CARD_WIDTH, height: CARD_HEIGHT }), action: 'scene', item: entry.item };
  }

  // The scrollbar's thumb across the whole strip; a press anywhere on the strip grabs it.
  function scrollbarRegion() {
    if (!maxScroll()) return null;
    const thumb = scrollThumb();
    return { ...SCROLLBAR_HIT, y: thumb.y, height: thumb.length, action: 'scrollbar' };
  }

  // Height on the panel canvas where the controller's ray meets the panel's plane, also past its edges,
  // so a grabbed scrollbar keeps following when the ray slips off the panel.
  const panelPlane = new THREE.Plane();
  const planePoint = new THREE.Vector3();
  function panelYFor(controller) {
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    panelPlane.normal.set(0, 0, 1).transformDirection(panel.mesh.matrixWorld);
    panelPlane.setFromNormalAndCoplanarPoint(panelPlane.normal, planePoint.setFromMatrixPosition(panel.mesh.matrixWorld));
    if (!raycaster.ray.intersectPlane(panelPlane, planePoint)) return null;
    panel.mesh.worldToLocal(planePoint);
    return (0.5 - planePoint.y / panel.size.height) * panel.canvas.height;
  }

  // The surface the pointers work on: the browser while it is open, else the rating card while it shows.
  const pointedSurface = () => (open ? panel : raterShown ? rater : null);

  function hitFor(controller) {
    const target = pointedSurface();
    if (!target) return null;
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    const [hit] = raycaster.intersectObjects([target.mesh], false);
    if (!hit) return null;
    const x = hit.uv.x * target.canvas.width;
    const y = (1 - hit.uv.y) * target.canvas.height;
    if (target === rater) {
      const star = RATER_STARS.find((candidate) => inside(candidate, x, y));
      return { hit, region: star ? { ...star, item: activeItem() } : null, x, y, inContent: false };
    }
    return { hit, region: regionAt(x, y), x, y, inContent: !sortMenuOpen && inside(CONTENT, x, y) };
  }

  function showHighlight(target, region) {
    highlight.visible = !!(target && region);
    if (!highlight.visible) return;
    if (highlight.parent !== target.mesh) target.mesh.add(highlight);
    const { canvas, size } = target;
    highlight.scale.set(region.width / canvas.width * size.width, region.height / canvas.height * size.height, 1);
    highlight.position.set(
      ((region.x + region.width / 2) / canvas.width - 0.5) * size.width,
      (0.5 - (region.y + region.height / 2) / canvas.height) * size.height,
      0.002,
    );
  }

  // Sits on the surface it points at, facing out, and keeps the same apparent size at any distance.
  function placeCursor(pointer, hit) {
    pointer.cursor.visible = !!hit;
    if (!hit) return;
    hit.object.matrixWorld.decompose(layerPosition, pointer.cursor.quaternion, layerScale);
    pointer.cursor.position.copy(hit.point);
    pointer.cursor.scale.setScalar(Math.max(0.4, hit.distance));
  }

  // Stands upright in front of the head, wherever the user looks at that moment, and stays there.
  function placeInFront(mesh, { distance, drop }) {
    const head = renderer.xr.getCamera().matrixWorld;
    headPosition.setFromMatrixPosition(head);
    headDirection.set(0, 0, -1).transformDirection(head);
    const yaw = Math.atan2(-headDirection.x, -headDirection.z);
    mesh.position.set(
      headPosition.x - Math.sin(yaw) * distance,
      headPosition.y - drop,
      headPosition.z - Math.cos(yaw) * distance,
    );
    mesh.rotation.set(0, yaw, 0);
  }

  function setOpen(value) {
    if (open === value || (value && !presenting)) return;
    open = value;
    if (open) {
      raterShown = false;
      placeInFront(panel.mesh, PANEL);
      // The grid page may have changed the order meanwhile.
      sort = savedSort();
      filter = savedFilter();
      sortMenuOpen = false;
      layoutScenes();
      fling = 0;
      scrollToActive();
      drawPanel();
    }
    panel.mesh.visible = open;
    highlight.visible = false;
    showNativeLayers();
    onOpenChange(open);
  }

  function activate(region) {
    if (region.action === 'close') setOpen(false);
    else if (region.action === 'sort-menu') {
      sortMenuOpen = !sortMenuOpen;
      panelStale = true;
    } else if (region.action === 'sort') {
      sort = saveSort(region.option);
      sortMenuOpen = false;
      layoutScenes();
      scroll = 0;
      panelStale = true;
      onOrderChange?.();
    } else if (region.action === 'filter') {
      filter = saveFilter(region.key);
      layoutScenes();
      fling = 0;
      scrollToActive();
      panelStale = true;
      onOrderChange?.();
    } else if (region.action === 'rate') {
      // The card stays where it is until the list is laid out again, even if it leaves the star class shown.
      onRate(region.item, region.item.rating === region.value ? 0 : region.value);
      panelStale = true;
      raterStale = true;
      if (raterShown) {
        raterRated = true;
        raterHideAt = performance.now() + RATER_AFTER_RATING_MS;
      }
    } else if (region.action === 'exit') {
      setOpen(false);
      onExit();
    }
    else if (region.action === 'scene') {
      setOpen(false);
      onSelect(region.item.id);
    }
  }

  // Trigger down starts a press; released without much movement it clicks what it started on, moved
  // over the list it drags the list along and leaves it gliding.
  function handlePress(pointer, found, seconds, now) {
    if (pointer.pressStarted) {
      pointer.pressStarted = false;
      pointer.press = { found, startY: found?.y, startScroll: scroll, dragging: false, velocity: 0, startedAt: now };
      if (found?.inContent) fling = 0;
      // Grabbed on the thumb it keeps that hold; elsewhere on the strip the thumb jumps under the pointer.
      if (found?.region?.action === 'scrollbar') {
        const thumb = scrollThumb();
        const onThumb = found.y >= thumb.y && found.y <= thumb.y + thumb.length;
        pointer.press.scrollbar = { offset: onThumb ? found.y - thumb.y : thumb.length / 2 };
        fling = 0;
        panelStale = true;
        pulse(pointer, 0.5, 20);
      }
    }
    const { press } = pointer;
    if (!press) return;
    if (press.scrollbar) {
      const y = pointer.pressed && open ? panelYFor(pointer.controller) : null;
      if (y !== null) {
        const thumb = scrollThumb();
        const travel = CONTENT.height - thumb.length;
        if (travel > 0) setScroll(((y - press.scrollbar.offset - CONTENT.y) / travel) * maxScroll());
      }
      if (!pointer.released) return;
      pointer.released = false;
      pointer.press = null;
      panelStale = true;
      return;
    }
    if (pointer.pressed && open && press.found?.inContent && found?.y !== undefined) {
      const moved = found.y - press.startY;
      if (!press.dragging && Math.abs(moved) > DRAG_THRESHOLD) press.dragging = true;
      if (press.dragging) {
        const before = scroll;
        setScroll(press.startScroll - moved);
        if (seconds > 0) press.velocity = THREE.MathUtils.lerp(press.velocity, (scroll - before) / seconds, 0.4);
      }
    }
    if (!pointer.released) return;
    pointer.released = false;
    pointer.press = null;
    if (press.dragging) {
      fling = press.velocity;
      return;
    }
    const target = press.found;
    if (target?.region) {
      pulse(pointer, 0.6, 30);
      activate(target.region);
    } else if (sortMenuOpen && target) {
      sortMenuOpen = false;
      panelStale = true;
    } else if (open && !target) {
      setOpen(false);
    } else if (raterShown && !target) {
      raterShown = false;
    } else if (!open && !raterShown && pointer.source?.handedness !== 'left' && now - press.startedAt < RATER_CLICK_MS) {
      setRaterShown(true);
    }
  }

  function updateScroll(seconds) {
    if (!open) return;
    const dragging = pointers.some((pointer) => pointer.press?.dragging);
    if (Math.abs(scrollStick) > 0) {
      fling = 0;
      setScroll(scroll - scrollStick * SCROLL_SPEED * seconds);
    } else if (!dragging && Math.abs(fling) > 1) {
      setScroll(scroll + fling * seconds);
      fling *= Math.exp(-SCROLL_FRICTION * seconds);
    }
    if (panelStale) {
      panelStale = false;
      drawPanel();
    }
  }

  // Call once per XR frame before rendering.
  function update() {
    const now = performance.now();
    const seconds = lastUpdate ? Math.min((now - lastUpdate) / 1000, 0.1) : 0;
    lastUpdate = now;
    rig.updateMatrixWorld(true);
    let hovered = null;
    for (const pointer of pointers) {
      if (!pointer.connected) {
        Object.assign(pointer, { pressStarted: false, released: false, press: null });
        continue;
      }
      const found = hitFor(pointer.controller);
      const hit = found?.hit;
      pointer.ray.scale.z = hit ? hit.distance : RAY_LENGTH;
      pointer.ray.material.opacity = hit ? 0.95 : 0.45;
      placeCursor(pointer, hit);
      if (found?.region && !pointer.press?.dragging) hovered = found.region;
      // A held scrollbar stays lit wherever the ray goes.
      if (pointer.press?.scrollbar) hovered = scrollbarRegion();
      // Pointing at the rating card keeps it up until a rating is given.
      if (found && raterShown && !raterRated) raterHideAt = Math.max(raterHideAt, now + RATER_IDLE_MS);
      // A short tick in the hand whenever the pointer moves onto something new.
      const region = found?.region;
      const target = region ? `${region.action}|${region.item?.id ?? ''}|${region.key ?? ''}|${region.value ?? ''}` : null;
      if (target && target !== pointer.target && !pointer.press?.dragging) pulse(pointer, 0.25, 12);
      pointer.target = target;
      handlePress(pointer, found, seconds, now);
    }
    updateScroll(seconds);
    updateRater(now);
    showHighlight(pointedSurface(), hovered);
    updateLoader(now);
    updateDistance(now);
    if (native) updateNativeLayers();
  }

  return {
    get isOpen() { return open; },
    setScenes(list, id) {
      // Another scene in view: its rating card would show the wrong scene.
      if (id !== activeId) raterShown = false;
      items = list;
      activeId = id;
      raterStale = true;
      layoutScenes();
      setScroll(scroll);
      panelStale = true;
    },
    // The depth stretch, while the stick changes it; min and max are the ends of its range.
    showDistance(value, min, max) {
      distanceState = { value, min, max };
      distanceUntil = performance.now() + DISTANCE_SHOW_MS;
    },
    // Draws the panel again, after a scene's rating changed from outside.
    redraw() {
      panelStale = true;
      raterStale = true;
    },
    // Right stick while the browser is open: -1 (down) to 1 (up), 0 at rest.
    setScrollStick(value) {
      scrollStick = value;
    },
    // { item, phase: 'download' | 'prepare' | 'error', loaded, total, message }, or null when done.
    setLoading(state) {
      clearTimeout(loaderErrorTimer);
      loading = state;
      if (state?.phase === 'error') {
        loaderErrorTimer = setTimeout(() => { if (loading === state) loading = null; }, LOADER_ERROR_MS);
      }
    },
    setPresenting(value) {
      presenting = value;
      if (!presenting) setOpen(false);
      raterShown = false;
      rater.mesh.visible = false;
      distanceUntil = 0;
      distanceCard.mesh.visible = false;
      loader.mesh.visible = false;
      loaderKey = '';
      for (const pointer of pointers) pointer.cursor.visible = false;
      if (presenting) {
        startNativeLayers();
      } else {
        stopNativeLayers();
      }
    },
    toggle() { setOpen(!open); },
    update,
  };
}
