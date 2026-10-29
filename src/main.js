import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PackedSplats, SparkRenderer, SparkXr, SplatLoader, SplatMesh, dyno } from '@sparkjsdev/spark';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const stage = $('#viewer-canvas');
const fileInput = $('#file-input');
const sceneList = $('#scene-list');
const sceneMenu = $('#scene-menu');
const menuToggle = $('#menu-toggle');
const menuBackdrop = $('#menu-backdrop');
const compareButton = $('#compare-button');
const compareOverlay = $('#compare-overlay');
const compareOriginal = $('#compare-original');
const compareDivider = $('#compare-divider');
const depthButton = $('#depth-button');
const depthLegend = $('#depth-legend');
const loadingPanel = $('#viewer-loading');
const loadingDetail = $('#viewer-loading-detail');
const dropOverlay = $('#drop-overlay');
const vrButton = $('#vr-button');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(53, 1, 0.015, 2000);
const canvas = document.createElement('canvas');
const context = canvas.getContext('webgl2', {
  alpha: true, antialias: false, depth: true, stencil: false, powerPreference: 'high-performance', xrCompatible: true,
});
const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x151515, 0);
stage.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', '3D view. Drag to orbit, scroll to zoom.');
scene.add(new SparkRenderer({ renderer }));
const xrRig = new THREE.Group();
xrRig.add(camera);
scene.add(xrRig);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.62;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.6;
controls.minDistance = 0.25;
controls.maxDistance = 250;
controls.screenSpacePanning = true;

let library = null;
let scenes = [];
const localScenes = [];
let sceneOrder = [];
const collapsedFoldersStorageKey = 'gaussian-viewer-collapsed-folders';
const collapsedFolders = new Set((() => {
  try {
    return JSON.parse(localStorage.getItem(collapsedFoldersStorageKey) || '[]');
  } catch {
    return [];
  }
})());
let activeSceneId = null;
let currentMesh = null;
let comparePosition = 50;
let compareDragging = false;
let compareEnabled = false;
let loadVersion = 0;
let toastTimer = null;
let dragDepth = 0;
let depthEnabled = false;
const lookDirection = new THREE.Vector3();
let xrSavedView = null;
let xrButtonsHeld = new Set();

const FOCUS_CELLS = 9;
const FOCUS_REACH = 0.03;

function measureFocusDistance(packedSplats) {
  const nearest = new Float32Array(FOCUS_CELLS * FOCUS_CELLS).fill(Infinity);
  packedSplats.forEachSplat((index, center, scales, quaternion, opacity) => {
    const z = center.z;
    if (!(z > 0) || opacity < 0.5) return;
    const u = center.x / z / FOCUS_REACH;
    const v = center.y / z / FOCUS_REACH;
    if (Math.abs(u) >= 1 || Math.abs(v) >= 1) return;
    const cell = Math.floor((v + 1) / 2 * FOCUS_CELLS) * FOCUS_CELLS + Math.floor((u + 1) / 2 * FOCUS_CELLS);
    if (z < nearest[cell]) nearest[cell] = z;
  });
  const depths = [...nearest].filter(Number.isFinite).sort((a, b) => a - b);
  return depths.length ? depths[Math.floor(depths.length / 2)] : null;
}

const DEPTH_SAMPLES = 20000;
const TURBO_RANGE = [0.08, 0.95];
const TURBO = [
  [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943],
  [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604],
  [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973],
];
const turboGlsl = `vec3 viewerTurbo(float t) {
  float x = mix(${TURBO_RANGE.join(', ')}, t);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(${TURBO.map((k) => `dot(v4, vec4(${k.slice(0, 4).join(', ')})) + dot(v2, vec2(${k.slice(4).join(', ')}))`).join(',\n    ')});
}`;

function turbo(t) {
  const x = THREE.MathUtils.lerp(...TURBO_RANGE, t);
  const powers = [1, x, x ** 2, x ** 3, x ** 4, x ** 5];
  return TURBO.map((k) => Math.round(THREE.MathUtils.clamp(k.reduce((sum, c, i) => sum + c * powers[i], 0), 0, 1) * 255));
}

function depthModifier(view, [near, far]) {
  const e = view.elements;
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const { rgb } = dyno.dyno({
      inTypes: { center: 'vec3', axis: 'vec4', near: 'float', far: 'float' },
      outTypes: { rgb: 'vec3' },
      inputs: {
        center,
        axis: dyno.dynoConst('vec4', [-e[2], -e[6], -e[10], -e[14]]),
        near: dyno.dynoConst('float', near),
        far: dyno.dynoConst('float', far),
      },
      globals: () => [turboGlsl],
      statements: ({ inputs, outputs }) => [
        `float depth = dot(vec4(${inputs.center}, 1.0), ${inputs.axis});`,
        `${outputs.rgb} = viewerTurbo(clamp((${inputs.far} - depth) / max(${inputs.far} - ${inputs.near}, 1e-6), 0.0, 1.0));`,
      ],
    }).outputs;
    return { gsplat: dyno.combineGsplat({ gsplat, rgb }) };
  });
}

function rememberStartView(mesh) {
  camera.updateMatrixWorld();
  mesh.updateMatrixWorld();
  mesh.userData.startView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  mesh.userData.startClip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, mesh.userData.startView);
}

function measureDepthRange(mesh) {
  const m = mesh.userData.startClip.elements;
  const stride = Math.max(1, Math.floor(mesh.packedSplats.numSplats / DEPTH_SAMPLES));
  const depths = [];
  mesh.packedSplats.forEachSplat((index, { x, y, z }, scales, quaternion, opacity) => {
    if (index % stride || opacity < 0.2) return;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0) return;
    if (Math.abs(m[0] * x + m[4] * y + m[8] * z + m[12]) <= w && Math.abs(m[1] * x + m[5] * y + m[9] * z + m[13]) <= w) depths.push(w);
  });
  if (depths.length < 10) return [0, 1];
  depths.sort((a, b) => a - b);
  const near = depths[Math.floor(depths.length * 0.02)];
  return [near, Math.max(depths[Math.floor(depths.length * 0.98)], near + 1e-3)];
}

function formatDepth(value, step) {
  return value.toFixed(THREE.MathUtils.clamp(Math.round(-Math.log10(step)) + 1, 0, 4));
}

function setDepthEnabled(enabled) {
  depthEnabled = enabled;
  depthButton.setAttribute('aria-pressed', String(enabled));
  depthLegend.hidden = !enabled || !currentMesh;
  if (!currentMesh) return;
  if (enabled) {
    const range = currentMesh.userData.depthRange ??= measureDepthRange(currentMesh);
    const ticks = depthLegend.querySelectorAll('.depth-legend-ticks span');
    const step = (range[1] - range[0]) / (ticks.length - 1);
    ticks.forEach((tick, index) => { tick.textContent = formatDepth(range[0] + step * index, step); });
    currentMesh.objectModifier = depthModifier(currentMesh.userData.startView, range);
  } else {
    currentMesh.objectModifier = undefined;
  }
  currentMesh.updateGenerator();
}

depthLegend.querySelector('.depth-legend-bar').style.background = `linear-gradient(90deg, ${
  Array.from({ length: 11 }, (_, i) => `rgb(${turbo(1 - i / 10).join(' ')}) ${i * 10}%`).join(', ')
})`;

function resetCamera() {
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.position.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, -(currentMesh?.userData.focusDistance || 3));
  controls.update();
  controls.enableDamping = damping;
}

function resize() {
  if (renderer.xr.isPresenting) return;
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function resetXrRig() {
  xrRig.position.set(0, 0, 0);
  xrRig.rotation.set(0, 0, 0);
}

function placeXrRig() {
  camera.getWorldDirection(lookDirection);
  xrRig.position.copy(camera.position);
  xrRig.rotation.set(0, Math.atan2(-lookDirection.x, -lookDirection.z), 0);
}

function handleXrButtons() {
  const held = new Set();
  for (const source of renderer.xr.getSession()?.inputSources ?? []) {
    const buttons = source.gamepad?.buttons;
    if (!buttons || source.hand) continue;
    if (buttons[4]?.pressed) held.add(`${source.handedness}-a`);
    if (buttons[5]?.pressed) held.add(`${source.handedness}-b`);
  }
  const pressed = (key) => held.has(key) && !xrButtonsHeld.has(key);
  if (pressed('right-a')) stepScene(1);
  if (pressed('right-b')) stepScene(-1);
  if (pressed('left-a') || pressed('left-b')) resetXrRig();
  xrButtonsHeld = held;
}

function setVrButtonState(presenting) {
  const label = presenting ? 'Exit VR' : 'View in VR';
  vrButton.setAttribute('aria-pressed', String(presenting));
  vrButton.setAttribute('aria-label', label);
  vrButton.title = label;
  vrButton.querySelector('span').textContent = presenting ? 'Exit VR' : 'VR';
}

const sparkXr = new SparkXr({
  renderer,
  element: vrButton,
  mode: 'vr',
  frameBufferScaleFactor: 1,
  controllers: { moveSpeed: 1.5, moveDirection: true },
  onReady: (supported) => { vrButton.hidden = !supported; },
});

renderer.xr.addEventListener('sessionstart', () => {
  setSceneMenuOpen(false);
  xrSavedView = { sceneId: activeSceneId, position: camera.position.clone(), target: controls.target.clone() };
  placeXrRig();
  controls.enabled = false;
  sparkXr.lastControllersUpdate = 0;
  xrButtonsHeld = new Set();
  setVrButtonState(true);
});

renderer.xr.addEventListener('sessionend', () => {
  resetXrRig();
  controls.enabled = true;
  if (xrSavedView && xrSavedView.sceneId === activeSceneId) {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    camera.position.copy(xrSavedView.position);
    camera.up.set(0, 1, 0);
    controls.target.copy(xrSavedView.target);
    controls.update();
    controls.enableDamping = damping;
  } else {
    resetCamera();
  }
  xrSavedView = null;
  setVrButtonState(false);
  resize();
});

resetCamera();
new ResizeObserver(resize).observe(stage);
resize();
renderer.setAnimationLoop(() => {
  if (renderer.xr.isPresenting) {
    sparkXr.updateControllers(camera);
    handleXrButtons();
  } else if (controls.enabled) {
    controls.update();
  }
  renderer.render(scene, camera);
});

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function formatBytes(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} MB` : `${Math.ceil(bytes / 1e3)} kB`;
}

function allScenes() {
  return [...scenes, ...localScenes];
}

function updateSceneActions(item) {
  const download = $('#download-link');
  download.hidden = !item.plyUrl;
  download.href = item.plyUrl;
  download.download = item.fileName;
  compareButton.hidden = !item.imageUrl;
  depthButton.hidden = false;
  $('#scene-name').textContent = item.name;
  $('#scene-name').title = item.name;
  if (item.imageUrl) compareOriginal.src = item.imageUrl;
  else compareOriginal.removeAttribute('src');
  if (!item.imageUrl) setCompareEnabled(false);
}

function updateSceneListSelection() {
  for (const button of sceneList.querySelectorAll('.scene-row-select')) {
    const selected = button.closest('.scene-row')?.dataset.sceneId === activeSceneId;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  const currentIndex = sceneOrder.indexOf(activeSceneId);
  $('#scene-position').textContent = currentIndex < 0 ? '' : `${currentIndex + 1} / ${sceneOrder.length}`;
  $('#scene-stepper').hidden = sceneOrder.length < 2;
}

function sceneRow(item, depth = 0) {
  const row = document.createElement('div');
  row.className = 'scene-row';
  row.dataset.sceneId = item.id;
  row.style.setProperty('--depth', depth);
  const button = document.createElement('button');
  button.className = 'scene-row-select';
  button.type = 'button';
  button.setAttribute('aria-label', `Open: ${item.name}`);
  button.title = item.name;
  if (item.imageUrl) {
    const image = document.createElement('img');
    image.src = item.imageUrl;
    image.alt = '';
    image.loading = 'lazy';
    button.append(image);
  } else {
    button.classList.add('no-preview');
  }
  const copy = document.createElement('span');
  copy.className = 'scene-row-copy';
  const name = document.createElement('span');
  name.className = 'scene-row-label';
  name.textContent = item.name;
  const detail = document.createElement('span');
  detail.className = 'scene-row-kind';
  detail.textContent = formatBytes(item.sizeBytes);
  copy.append(name, detail);
  button.append(copy);
  button.addEventListener('click', () => {
    setSceneMenuOpen(false);
    void selectScene(item.id);
  });
  row.append(button);
  return row;
}

function folderScenes(node) {
  return [...node.folders.flatMap(folderScenes), ...node.scenes];
}

function folderBlock(node, depth) {
  const block = document.createElement('div');
  block.className = 'library-folder';
  const head = document.createElement('div');
  head.className = 'scene-row library-folder-row';
  head.style.setProperty('--depth', depth);
  const toggle = document.createElement('button');
  toggle.className = 'library-folder-toggle';
  toggle.type = 'button';
  const collapsed = collapsedFolders.has(node.path);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>';
  const name = document.createElement('span');
  name.className = 'scene-row-label';
  name.textContent = node.name;
  const count = document.createElement('span');
  count.className = 'scene-row-kind';
  count.textContent = String(folderScenes(node).length);
  toggle.append(name, count);
  toggle.addEventListener('click', () => {
    if (collapsedFolders.has(node.path)) collapsedFolders.delete(node.path);
    else collapsedFolders.add(node.path);
    try {
      localStorage.setItem(collapsedFoldersStorageKey, JSON.stringify([...collapsedFolders]));
    } catch {}
    renderSceneList();
  });
  head.append(toggle);
  block.append(head);
  if (!collapsed) block.append(...nodeRows(node, depth + 1));
  return block;
}

function nodeRows(node, depth) {
  return [...node.folders.map((child) => folderBlock(child, depth)),
    ...node.scenes.map((item) => sceneRow(item, depth))];
}

function renderSceneList() {
  sceneList.replaceChildren();
  const tree = library?.tree;
  sceneOrder = allScenes().map((item) => item.id);
  $('#library-path').textContent = library?.root || '';
  $('#library-path').title = library?.root || '';
  const total = allScenes().length;
  $('#scene-count').textContent = `${total} ${total === 1 ? 'scene' : 'scenes'}`;
  if (library && !library.exists) {
    const missing = document.createElement('p');
    missing.className = 'scene-list-empty';
    missing.textContent = 'The scene folder does not exist.';
    sceneList.append(missing);
  } else if (!scenes.length) {
    const empty = document.createElement('p');
    empty.className = 'scene-list-empty';
    empty.textContent = 'The scene folder has no splat files yet.';
    sceneList.append(empty);
  }
  if (tree) sceneList.append(...nodeRows(tree, 0));
  if (localScenes.length) {
    const heading = document.createElement('p');
    heading.className = 'scene-list-heading';
    heading.textContent = 'Opened files';
    sceneList.append(heading, ...localScenes.map((item) => sceneRow(item)));
  }
  updateSceneListSelection();
}

function setCompareEnabled(enabled) {
  compareEnabled = enabled && !!activeSceneId && !!compareOriginal.getAttribute('src');
  compareButton.setAttribute('aria-pressed', String(compareEnabled));
  compareOverlay.hidden = !compareEnabled;
  compareDivider.hidden = !compareEnabled;
  compareOverlay.setAttribute('aria-hidden', String(!compareEnabled));
  updateComparePosition(comparePosition);
}

function updateComparePosition(value) {
  comparePosition = THREE.MathUtils.clamp(value, 0, 100);
  compareOverlay.style.setProperty('--compare-position', `${comparePosition}%`);
  compareDivider.style.left = `${comparePosition}%`;
  compareDivider.setAttribute('aria-valuenow', String(Math.round(comparePosition)));
}

function moveCompareDivider(clientX) {
  const bounds = stage.getBoundingClientRect();
  if (bounds.width) updateComparePosition(((clientX - bounds.left) / bounds.width) * 100);
}

function setSceneMenuOpen(open) {
  sceneMenu.hidden = !open;
  menuBackdrop.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  if (open) (sceneMenu.querySelector('.scene-row-select.active') || sceneMenu.querySelector('.scene-row-select'))?.focus();
  else if (sceneMenu.contains(document.activeElement)) menuToggle.focus();
}

function stepScene(direction) {
  if (!sceneOrder.length) return;
  const currentIndex = sceneOrder.indexOf(activeSceneId);
  const nextIndex = (currentIndex + direction + sceneOrder.length) % sceneOrder.length;
  void selectScene(sceneOrder[nextIndex]);
}

function showLibrary(data) {
  library = data;
  scenes = library.tree ? folderScenes(library.tree) : [];
  renderSceneList();
}

async function fetchScenes() {
  const response = await fetch('/api/scenes', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load scenes.');
  showLibrary(await response.json());
}

function clearScene() {
  loadVersion += 1;
  loadingPanel.hidden = true;
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh.dispose?.();
    currentMesh = null;
  }
  activeSceneId = null;
  $('#download-link').hidden = true;
  compareButton.hidden = true;
  depthButton.hidden = true;
  $('#scene-name').textContent = '';
  setCompareEnabled(false);
  setDepthEnabled(depthEnabled);
  updateSceneListSelection();
  $('#viewer-empty').hidden = false;
}

async function chooseFolder() {
  const buttons = document.querySelectorAll('.folder-button');
  for (const button of buttons) button.disabled = true;
  try {
    const response = await fetch('/api/folder', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not choose a folder.');
    if (!data.changed) return;
    showLibrary(data);
    if (scenes.length) {
      activeSceneId = null;
      await selectScene(scenes[0].id);
    } else {
      clearScene();
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

async function loadPackedSplats(item, version) {
  if (item.file) {
    const fileBytes = new Uint8Array(await item.file.arrayBuffer());
    const packedSplats = new PackedSplats({ fileBytes, fileName: item.file.name });
    await packedSplats.initialized;
    return packedSplats;
  }
  return new SplatLoader().loadAsync(item.plyUrl, (event) => {
    if (version !== loadVersion || event.type !== 'progress') return;
    if (event.lengthComputable && event.total) {
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      loadingDetail.textContent = `Loading scene · ${percent} %`;
    }
  });
}

async function selectScene(id) {
  const item = allScenes().find((entry) => entry.id === id);
  if (!item) return false;
  if (activeSceneId === id && currentMesh) return true;
  const version = ++loadVersion;
  $('#viewer-empty').hidden = true;
  loadingPanel.hidden = false;
  loadingDetail.textContent = 'Loading scene …';
  try {
    const packedSplats = await loadPackedSplats(item, version);
    if (version !== loadVersion) {
      packedSplats.dispose?.();
      return false;
    }
    const mesh = new SplatMesh({ packedSplats });
    mesh.userData.focusDistance = measureFocusDistance(packedSplats);
    mesh.quaternion.set(1, 0, 0, 0);
    scene.add(mesh);
    if (currentMesh) {
      scene.remove(currentMesh);
      currentMesh.dispose?.();
    }
    currentMesh = mesh;
    activeSceneId = id;
    updateSceneListSelection();
    updateSceneActions(item);
    resetCamera();
    rememberStartView(mesh);
    if (depthEnabled) setDepthEnabled(true);
    if (renderer.xr.isPresenting) resetXrRig();
    loadingPanel.hidden = true;
    return true;
  } catch (error) {
    if (version !== loadVersion) return false;
    loadingPanel.hidden = true;
    $('#viewer-empty').hidden = !!currentMesh;
    showToast(`Could not load splat: ${error.message}`, true);
    console.error(error);
    return false;
  }
}

function openLocalFile(file) {
  if (!file) return;
  if (!/\.(ply|spz|splat|ksplat)$/i.test(file.name)) {
    showToast('Choose a .ply, .spz, .splat or .ksplat file.', true);
    return;
  }
  const id = `local:${file.name}:${file.size}:${file.lastModified}`;
  if (!localScenes.some((item) => item.id === id)) {
    localScenes.push({
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      sizeBytes: file.size,
      plyUrl: URL.createObjectURL(file),
      fileName: file.name,
      imageUrl: null,
      file,
    });
    renderSceneList();
  }
  setSceneMenuOpen(false);
  void selectScene(id);
}

$('#open-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  openLocalFile(fileInput.files?.[0]);
  fileInput.value = '';
});
menuToggle.addEventListener('click', () => setSceneMenuOpen(sceneMenu.hidden));
$('#menu-close').addEventListener('click', () => { setSceneMenuOpen(false); menuToggle.focus(); });
menuBackdrop.addEventListener('click', () => setSceneMenuOpen(false));
$('#library-refresh').addEventListener('click', () => {
  fetchScenes().catch((error) => showToast(error.message, true));
});
for (const button of document.querySelectorAll('.folder-button')) button.addEventListener('click', () => chooseFolder());
compareButton.addEventListener('click', () => setCompareEnabled(!compareEnabled));
depthButton.addEventListener('click', () => setDepthEnabled(!depthEnabled));
compareDivider.addEventListener('pointerdown', (event) => {
  compareDragging = true;
  compareDivider.setPointerCapture(event.pointerId);
  moveCompareDivider(event.clientX);
});
compareDivider.addEventListener('pointermove', (event) => {
  if (compareDragging && compareDivider.hasPointerCapture(event.pointerId)) moveCompareDivider(event.clientX);
});
const stopCompareDrag = () => { compareDragging = false; };
compareDivider.addEventListener('pointerup', stopCompareDrag);
compareDivider.addEventListener('pointercancel', stopCompareDrag);
compareDivider.addEventListener('lostpointercapture', stopCompareDrag);
compareDivider.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    updateComparePosition(comparePosition + (event.key === 'ArrowRight' ? 2 : -2));
  } else if (event.key === 'Home') {
    updateComparePosition(0);
  } else if (event.key === 'End') {
    updateComparePosition(100);
  }
});
$('#scene-previous').addEventListener('click', () => stepScene(-1));
$('#scene-next').addEventListener('click', () => stepScene(1));
$('#reset-view').addEventListener('click', () => (renderer.xr.isPresenting ? resetXrRig() : resetCamera()));

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  openLocalFile(event.dataTransfer?.files?.[0]);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !sceneMenu.hidden) {
    setSceneMenuOpen(false);
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (!sceneMenu.hidden) return;
  if (event.target.closest?.('input, select, textarea, [contenteditable], [role="slider"]')) return;
  if (sceneOrder.length < 2) return;
  event.preventDefault();
  stepScene(event.key === 'ArrowRight' ? 1 : -1);
});

try {
  await fetchScenes();
  if (scenes.length) await selectScene(scenes[0].id);
  else $('#viewer-empty').hidden = false;
} catch (error) {
  $('#viewer-empty').hidden = false;
  showToast(error.message, true);
}
