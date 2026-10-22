import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PackedSplats, SparkRenderer, SparkXr, SplatLoader, SplatMesh } from '@sparkjsdev/spark';
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
const modeSelect = $('#mode-select');
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
renderer.domElement.setAttribute('aria-label', '3D view');
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
const modeOverrides = new Map();
let activeSceneId = null;
let currentMesh = null;
let comparePosition = 50;
let compareDragging = false;
let compareEnabled = false;
let loadVersion = 0;
let toastTimer = null;
let dragDepth = 0;
let viewerMode = 'image';
let viewerCoverage = 360;
const lookDirection = new THREE.Vector3();
const movement = new THREE.Vector3();
const pressedKeys = new Set();
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);
let lastFrameTime = null;
let movementFast = false;
let xrSavedView = null;
let xrButtonsHeld = new Set();

function stopMovement() {
  pressedKeys.clear();
  movementFast = false;
  lastFrameTime = null;
}

function movePanoramaCamera(deltaSeconds) {
  if (viewerMode !== 'panorama' || !currentMesh || document.activeElement !== renderer.domElement) return;
  const forward = Number(pressedKeys.has('KeyW')) - Number(pressedKeys.has('KeyS'));
  const sideways = Number(pressedKeys.has('KeyD')) - Number(pressedKeys.has('KeyA'));
  const vertical = Number(pressedKeys.has('KeyE')) - Number(pressedKeys.has('KeyQ'));
  camera.getWorldDirection(lookDirection);
  const yaw = Math.atan2(lookDirection.x, -lookDirection.z);
  movement.set(
    Math.sin(yaw) * forward + Math.cos(yaw) * sideways,
    vertical,
    -Math.cos(yaw) * forward + Math.sin(yaw) * sideways,
  );
  if (movement.lengthSq() === 0) return;
  const speed = movementFast ? 6 : 2;
  movement.normalize().multiplyScalar(speed * deltaSeconds);
  camera.position.add(movement);
  controls.target.add(movement);
}

function rotatePanoramaView(yawDelta, pitchDelta) {
  const position = camera.position.clone();
  const target = controls.target.clone();
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.position.copy(position);
  controls.target.copy(target);
  const distance = controls.getDistance();
  lookDirection.subVectors(controls.target, camera.position).normalize();
  let yaw = Math.atan2(lookDirection.x, -lookDirection.z) + yawDelta;
  const pitch = THREE.MathUtils.clamp(
    Math.asin(THREE.MathUtils.clamp(lookDirection.y, -1, 1)) + pitchDelta,
    -Math.PI / 2 + 0.01,
    Math.PI / 2 - 0.01,
  );
  if (viewerCoverage === 180) yaw = THREE.MathUtils.clamp(yaw, -Math.PI / 2, Math.PI / 2);
  const horizontal = Math.cos(pitch);
  lookDirection.set(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch),
    -Math.cos(yaw) * horizontal,
  );
  controls.target.copy(camera.position).addScaledVector(lookDirection, distance);
  controls.update();
  controls.enableDamping = damping;
}

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

function resetCamera() {
  stopMovement();
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.position.set(0, 0, 0);
  camera.up.set(0, 1, 0);
  camera.fov = viewerMode === 'panorama' ? 75 : 53;
  camera.updateProjectionMatrix();
  const focus = viewerMode === 'image' ? currentMesh?.userData.focusDistance : null;
  controls.target.set(0, 0, -(focus || 3));
  controls.update();
  controls.enableDamping = damping;
}

function setViewerMode(mode) {
  viewerCoverage = mode === 'hemisphere' ? 180 : 360;
  viewerMode = ['panorama', 'hemisphere'].includes(mode) ? 'panorama' : 'image';
  modeSelect.value = ['panorama', 'hemisphere'].includes(mode) ? mode : 'image';
  controls.minAzimuthAngle = viewerCoverage === 180 ? -Math.PI / 2 : -Infinity;
  controls.maxAzimuthAngle = viewerCoverage === 180 ? Math.PI / 2 : Infinity;
  stage.classList.toggle('panorama', viewerMode === 'panorama');
  stage.classList.remove('dragging');
  $('#viewer-hint').textContent = viewerMode === 'panorama'
    ? 'Drag to tilt · Arrow keys to turn · Scroll to zoom'
    : 'Drag to orbit · Scroll to zoom';
  const help = viewerMode === 'panorama'
    ? 'Drag to tilt the scene. Arrow keys turn the view; Shift turns faster. W/S forward and back, A/D sideways, Q/E up and down. Scroll to zoom.'
    : 'Drag to orbit, scroll to zoom.';
  $('#viewer-hint').title = help;
  renderer.domElement.setAttribute('aria-label', `3D view. ${help}`);
  resetCamera();
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  renderer.domElement.focus({ preventScroll: true });
  movementFast = event.shiftKey;
});
controls.addEventListener('start', () => {
  stage.classList.add('dragging');
});
controls.addEventListener('end', () => {
  stage.classList.remove('dragging');
});

renderer.domElement.addEventListener('keydown', (event) => {
  if (viewerMode !== 'panorama' || !currentMesh || renderer.xr.isPresenting) return;
  if (event.ctrlKey || event.altKey || event.metaKey) {
    stopMovement();
    return;
  }
  if (event.code.startsWith('Arrow')) {
    event.preventDefault();
    if (event.repeat) return;
    const angle = THREE.MathUtils.degToRad(event.shiftKey ? 12 : 4);
    if (event.code === 'ArrowLeft') rotatePanoramaView(-angle, 0);
    else if (event.code === 'ArrowRight') rotatePanoramaView(angle, 0);
    else if (event.code === 'ArrowUp') rotatePanoramaView(0, angle);
    else if (event.code === 'ArrowDown') rotatePanoramaView(0, -angle);
    return;
  }
  if (!movementKeys.has(event.code)) return;
  event.preventDefault();
  movementFast = event.shiftKey;
  pressedKeys.add(event.code);
});
renderer.domElement.addEventListener('keyup', (event) => {
  movementFast = event.shiftKey;
  pressedKeys.delete(event.code);
});
renderer.domElement.addEventListener('blur', stopMovement);
window.addEventListener('blur', stopMovement);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMovement();
});

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
  stopMovement();
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
renderer.setAnimationLoop((time) => {
  const deltaSeconds = lastFrameTime === null ? 0 : Math.min(0.1, Math.max(0, (time - lastFrameTime) / 1000));
  lastFrameTime = time;
  if (renderer.xr.isPresenting) {
    sparkXr.updateControllers(camera);
    handleXrButtons();
  } else {
    movePanoramaCamera(deltaSeconds);
    if (controls.enabled) controls.update();
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

function sceneMode(item) {
  return modeOverrides.get(item.id) || item.mode || 'image';
}

function sceneKindText(item) {
  const mode = sceneMode(item);
  const coverage = mode === 'panorama' ? '360°' : mode === 'hemisphere' ? '180°' : 'Photo';
  return [coverage, formatBytes(item.sizeBytes)].join(' · ');
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
  detail.textContent = sceneKindText(item);
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

async function fetchScenes() {
  const response = await fetch('/api/scenes', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load scenes.');
  library = await response.json();
  scenes = library.tree ? folderScenes(library.tree) : [];
  renderSceneList();
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
    setViewerMode(sceneMode(item));
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
      mode: 'image',
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
modeSelect.addEventListener('change', () => {
  if (activeSceneId) {
    modeOverrides.set(activeSceneId, modeSelect.value);
    renderSceneList();
  }
  setViewerMode(modeSelect.value);
});
menuToggle.addEventListener('click', () => setSceneMenuOpen(sceneMenu.hidden));
$('#menu-close').addEventListener('click', () => { setSceneMenuOpen(false); menuToggle.focus(); });
menuBackdrop.addEventListener('click', () => setSceneMenuOpen(false));
$('#library-refresh').addEventListener('click', () => {
  fetchScenes().catch((error) => showToast(error.message, true));
});
compareButton.addEventListener('click', () => setCompareEnabled(!compareEnabled));
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
