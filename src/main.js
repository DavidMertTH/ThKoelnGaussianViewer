import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PackedSplats, SparkRenderer, SparkXr, SplatMesh, dyno } from '@sparkjsdev/spark';
import { Ambilight } from './ambilight.js';
import { ComputeSplats, createComputeSplatRenderer } from './compute-splats.js';
import { createRatingPanel } from './rating-panel.js';
import { browserOrder, savedSort } from './scene-sort.js';
import { createVrSceneBrowser } from './vr-browser.js';
import { WebGpuXr, webGpuXrSupported } from './webgpu-xr.js';
import { HeadTracker } from './head-tracker.js';
import { ScreenViews, WebGlAnaglyph } from './screen-views.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const stage = $('#viewer-canvas');
const fileInput = $('#file-input');
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
const offsetControl = $('#offset-control');
const offsetSlider = $('#offset-slider');
const offsetValue = $('#offset-value');
const fpsValue = $('#fps-value');
const fpsTiming = $('#fps-timing');
const fpsDetail = $('#fps-detail');
const fpsGpu = $('#fps-gpu');
const fpsCpu = $('#fps-cpu');

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
// Scenes kept in memory for quick switching keep their detail tree in Spark's worker for a while too,
// so coming back does not rebuild it.
const spark = new SparkRenderer({ renderer, lodCleanupTimeoutMs: 5 * 60 * 1000 });
scene.add(spark);
// A headset draws two large views per frame, so trim the footprint and skip tiny splats there.
// In VR the centre of the image (the start view along -Z) gets full detail, falling off towards the edge,
// rather than following where the head points, so turning the head never makes splats pop in. The cones
// roughly span the photo. The desktop view draws every splat at full quality; level of detail only runs in VR.
const SPARK_DESKTOP = {
  enableLod: false, maxStdDev: Math.sqrt(8), lodRenderScale: 1, lodSplatScale: 1,
  lodQuatOverride: undefined, coneFov0: 90, coneFov: 120, coneFoveate: 0.4,
};
const SPARK_XR = {
  enableLod: true, maxStdDev: Math.sqrt(5), lodRenderScale: 1, lodSplatScale: 0.7,
  lodQuatOverride: new THREE.Quaternion(), coneFov0: 40, coneFov: 90, coneFoveate: 0.3,
};
Object.assign(spark, SPARK_DESKTOP);
const detailBuilds = new WeakMap();
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
let activeSceneId = null;
// The scene being loaded or shown; stepping goes on from here even before a load finishes.
let requestedScene = null;
let currentMesh = null;
let loadAbort = null;
// Scenes already seen stay in memory, least recently shown first. Only the current one is in the
// scene graph, so the others cost memory but no render time.
const SCENE_CACHE_SPLATS = 5e6;
const sceneCache = new Map();
let comparePosition = 50;
let compareDragging = false;
let compareEnabled = false;
let loadVersion = 0;
let toastTimer = null;
let dragDepth = 0;
let depthEnabled = false;
// Each splat moves away from the start view by stretch × its depth behind the nearest surface,
// so the front stays put and far splats travel furthest.
const depthStretch = dyno.dynoFloat(0);
// The slider shows 1 + stretch. Every scene opens at ×1.00, since the distance is part of its rating.
const DEFAULT_DEPTH_STRETCH = 0;
// The start camera sits at the origin looking down -Z, so this axis points away from the viewer.
const STRETCH_AXIS = new THREE.Vector3(0, 0, -1);
const lookDirection = new THREE.Vector3();
let xrSavedView = null;
let xrButtonsHeld = new Set();
let xrLastFrameTime = 0;
// Set by "Enter VR" after "Open VR" on the start page: the session starts in the scene browser.
let xrOpenBrowserOnStart = false;

const STICK_DEADZONE = 0.15;
// A sideways flick of the right stick past this steps once; it has to come back to centre to step again.
const STICK_FLICK = 0.7;
const STICK_RELEASE = 0.3;
let stickFlicked = false;
// Depth stretch per second at full stick deflection.
const STICK_STRETCH_SPEED = 1.2;

const FPS_INTERVAL = 500;
const fpsCanvas = Object.assign(document.createElement('canvas'), { width: 512, height: 316 });
const fpsContext = fpsCanvas.getContext('2d');
const fpsTexture = new THREE.CanvasTexture(fpsCanvas);
fpsTexture.colorSpace = THREE.SRGBColorSpace;
const fpsHud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.16, 0.16 * 316 / 512),
  new THREE.MeshBasicMaterial({ map: fpsTexture, transparent: true, depthTest: false, depthWrite: false }),
);
fpsHud.renderOrder = 1e6;
fpsHud.frustumCulled = false;
fpsHud.matrixAutoUpdate = false;
fpsHud.matrixWorldAutoUpdate = false;
fpsHud.visible = false;
// Pin the HUD to the head pose of the frame being drawn; as a child of the camera it would trail one frame behind.
const fpsHudOffset = new THREE.Matrix4().makeTranslation(-0.13, -0.11, -0.6);
fpsHud.onBeforeRender = () => fpsHud.matrixWorld.multiplyMatrices(renderer.xr.getCamera().matrixWorld, fpsHudOffset);
scene.add(fpsHud);
// Frame-rate displays only show when the server runs with --debug.
let debugMode = false;
// CPU times per frame: the WebGPU splat pass (compute renderer only) and the rest of the frame.
const fpsStats = { windowStart: 0, lastTime: 0, frames: 0, maxDelta: 0, splatCpu: 0, frameCpu: 0 };

// Scenes from the folder get a thumbnail for the scene browser the first time they are shown.
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 300;
const THUMBNAIL_DELAY = 1500;
let thumbnailRequest = null;

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

// Two splat renderers: WebGPU compute shaders by default, Spark on WebGL as the alternative. The footer
// switch or ?renderer=webgl|compute picks one and the choice is remembered. Without WebGPU the viewer
// falls back to Spark.
const rendererStorageKey = 'gaussian-viewer-renderer';

function chosenRenderer() {
  const requested = new URLSearchParams(location.search).get('renderer');
  if (requested === 'compute' || requested === 'webgl') {
    try {
      localStorage.setItem(rendererStorageKey, requested);
    } catch {}
    return requested;
  }
  try {
    return localStorage.getItem(rendererStorageKey) === 'webgl' ? 'webgl' : 'compute';
  } catch {
    return 'compute';
  }
}

let computeRenderer = null;
let computeUnavailable = '';
const immersiveVr = navigator.xr ? await navigator.xr.isSessionSupported('immersive-vr').catch(() => false) : false;
if (chosenRenderer() === 'compute' && immersiveVr && !webGpuXrSupported()) {
  // On a headset the compute renderer only pays off when it draws straight into the VR image.
  computeUnavailable = 'VR on WebGPU needs "WebXR experimental features" in chrome://flags and a browser restart';
} else if (chosenRenderer() === 'compute') {
  try {
    computeRenderer = await createComputeSplatRenderer({ turbo: { range: TURBO_RANGE, coefficients: TURBO }, xrCompatible: immersiveVr });
    // Under the WebGL canvas, which stays on top for the orbit controls.
    stage.prepend(computeRenderer.canvas);
    // Spark has nothing to draw on this path.
    scene.remove(spark);
  } catch (error) {
    computeUnavailable = error.message;
    console.warn('The compute renderer is not available, using Spark instead.', error);
  }
}
const drawingBufferSize = new THREE.Vector2();
const fullViewport = new THREE.Vector4();
const sortOrigin = new THREE.Vector3();

// With the compute renderer, VR runs on WebGPU and draws into the headset's image directly; otherwise
// three.js and Spark run the session on WebGL.
// The ambilight lies under both splat canvases and is always on.
let ambilight = null;
try {
  ambilight = new Ambilight();
  stage.prepend(ambilight.canvas);
} catch (error) {
  console.warn('The ambilight is not available.', error);
}

const gpuXr = computeRenderer && immersiveVr ? new WebGpuXr({ computeRenderer, scene, rig: xrRig, frameBufferScale: 1, foveation: 1 }) : null;
const xrPresenting = () => renderer.xr.isPresenting || !!gpuXr?.presenting;
const xrSession = () => gpuXr?.session ?? renderer.xr.getSession();

// Unplugging the headset or letting it sleep can take the GPU away from the page, and nothing draws
// after that. A fresh page load sets the renderer up again and reopens the scene from the address.
const GPU_RECOVERY_KEY = 'gaussian-viewer-gpu-recovery';
const GPU_RECOVERY_PAUSE_MS = 15000;
function reloadAfterGpuLoss(reason) {
  console.warn(`The GPU was lost (${reason}); reloading the page.`);
  let lastReload = 0;
  try {
    lastReload = Number(sessionStorage.getItem(GPU_RECOVERY_KEY)) || 0;
  } catch {}
  // Lost again right after a reload: stop instead of reloading in a loop.
  if (Date.now() - lastReload < GPU_RECOVERY_PAUSE_MS) {
    showToast('The graphics device was lost. Reload the page to continue.', true);
    return;
  }
  try {
    sessionStorage.setItem(GPU_RECOVERY_KEY, String(Date.now()));
  } catch {}
  location.reload();
}
computeRenderer?.device.lost.then((info) => {
  if (info.reason !== 'destroyed') reloadAfterGpuLoss(info.message || 'WebGPU device lost');
});
// Chrome also drops the WebGL context for a moment when it moves it to the headset's GPU and gives it
// back right away; only a context that stays lost means the GPU is gone.
const WEBGL_RESTORE_WAIT_MS = 3000;
let webglLostTimer = null;
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  clearTimeout(webglLostTimer);
  webglLostTimer = setTimeout(() => reloadAfterGpuLoss('WebGL context lost'), WEBGL_RESTORE_WAIT_MS);
});
renderer.domElement.addEventListener('webglcontextrestored', () => clearTimeout(webglLostTimer));
// A headset plugged in after the page loaded: the renderer was set up without VR, so start over with it.
// A VR runtime can also report a headset only just after the page asked, so this reloads at most once a
// minute rather than over and over.
const HEADSET_RELOAD_KEY = 'gaussian-viewer-headset-reload';
const HEADSET_RELOAD_PAUSE_MS = 60000;
navigator.xr?.addEventListener('devicechange', async () => {
  const supported = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!supported || immersiveVr || xrPresenting()) return;
  try {
    if (Date.now() - (Number(sessionStorage.getItem(HEADSET_RELOAD_KEY)) || 0) < HEADSET_RELOAD_PAUSE_MS) return;
    sessionStorage.setItem(HEADSET_RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  location.reload();
});

const vrBrowser = createVrSceneBrowser({
  renderer: gpuXr ? gpuXr.adapter : renderer,
  scene,
  rig: xrRig,
  onOpenChange: (open) => {
    // The panel covers the view; skipping the splats meanwhile keeps the browser smooth.
    if (currentMesh) currentMesh.visible = !open;
    if (sparkXr) sparkXr.lastControllersUpdate = 0;
    if (open) refreshScenes();
  },
  onSelect: (id) => void selectScene(id),
  // Stepping follows the panel's sort; the next and previous scene change with it.
  onOrderChange: () => {
    updateScenePosition();
    prefetchNeighbors();
  },
  onExit: () => (gpuXr?.presenting ? gpuXr.end() : renderer.xr.getSession()?.end()),
});

const ratingPanel = createRatingPanel({
  distance: () => 1 + depthStretch.value,
  onShowDistance: (factor) => setDepthStretch(THREE.MathUtils.clamp(factor - 1, Number(offsetSlider.min), Number(offsetSlider.max)), false),
  showToast,
});

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

function stretchModifier(view, near) {
  const e = view.elements;
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const { pushed } = dyno.dyno({
      inTypes: { center: 'vec3', axis: 'vec4', near: 'float', stretch: 'float' },
      outTypes: { pushed: 'vec3' },
      inputs: {
        center,
        axis: dyno.dynoConst('vec4', [-e[2], -e[6], -e[10], -e[14]]),
        near: dyno.dynoConst('float', near),
        stretch: depthStretch,
      },
      statements: ({ inputs, outputs }) => [
        `float depth = dot(vec4(${inputs.center}, 1.0), ${inputs.axis});`,
        `${outputs.pushed} = ${inputs.center} + ${inputs.axis}.xyz * max(depth - ${inputs.near}, 0.0) * ${inputs.stretch};`,
      ],
    }).outputs;
    return { gsplat: dyno.combineGsplat({ gsplat, center: pushed }) };
  });
}

// The photo's camera sits at the origin looking down -Z, so the start view is the scene's own transform.
// It is taken from the scene rather than from the viewer's camera, which hangs on the VR rig and may
// be turned: depth colours and the distance stretch run square to the loaded picture, wherever the
// viewer or the head points.
function rememberStartView(mesh) {
  mesh.updateMatrixWorld();
  mesh.userData.startView = mesh.matrixWorld.clone();
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
  const { startView, depthRange: range } = currentMesh.userData;
  if (enabled) updateDepthLegend();
  // The compute renderer reads depth colours and stretch from these settings every frame.
  if (currentMesh.isComputeSplats) return;
  const modifiers = [stretchModifier(startView, range[0])];
  // Colour by the original depth, before the stretch moves the splats.
  if (enabled) modifiers.unshift(depthModifier(startView, range));
  currentMesh.objectModifiers = modifiers;
  currentMesh.updateGenerator();
}

function updateDepthLegend() {
  const range = currentMesh?.userData.depthRange;
  if (!range) return;
  const ticks = depthLegend.querySelectorAll('.depth-legend-ticks span');
  const step = (range[1] - range[0]) / (ticks.length - 1);
  const factor = 1 + depthStretch.value;
  ticks.forEach((tick, index) => { tick.textContent = formatDepth(range[0] + step * index * factor, step * factor); });
}

function stretchedFocus(stretch) {
  const focus = currentMesh?.userData.focusDistance || 3;
  const near = currentMesh?.userData.depthRange?.[0] ?? focus;
  return focus + Math.max(focus - near, 0) * stretch;
}

// byUser: the slider or the stick changed it, so it goes into the scene's rating.
function setDepthStretch(value, byUser = true) {
  controls.target.addScaledVector(STRETCH_AXIS, stretchedFocus(value) - stretchedFocus(depthStretch.value));
  depthStretch.value = value;
  offsetSlider.value = String(value);
  offsetValue.textContent = `×${(1 + value).toFixed(2)}`;
  currentMesh?.updateVersion();
  updateDepthLegend();
  if (byUser) ratingPanel.distanceChanged();
  else ratingPanel.showDistance();
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
  controls.target.set(0, 0, -stretchedFocus(depthStretch.value));
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

const xrHeadPosition = new THREE.Vector3();
const xrHeadRotation = new THREE.Quaternion();
const xrHeadScale = new THREE.Vector3();
const xrHeadAngles = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

// Back to the scene's start view. In VR the rig also cancels where the head stands and faces in the
// room, so the head itself lands on the start view, looking straight ahead.
function resetXrRig() {
  xrRig.position.set(0, 0, 0);
  xrRig.rotation.set(0, 0, 0);
  if (!xrPresenting()) return;
  const headLocal = gpuXr?.presenting ? gpuXr.headLocal : camera.matrix;
  headLocal.decompose(xrHeadPosition, xrHeadRotation, xrHeadScale);
  const yaw = xrHeadAngles.setFromQuaternion(xrHeadRotation, 'YXZ').y;
  xrRig.rotation.set(0, -yaw, 0);
  xrRig.position.copy(xrHeadPosition).applyAxisAngle(UP, -yaw).negate();
}

function placeXrRig() {
  camera.getWorldDirection(lookDirection);
  xrRig.position.copy(camera.position);
  xrRig.rotation.set(0, Math.atan2(-lookDirection.x, -lookDirection.z), 0);
}

function handleXrInput(seconds) {
  const held = new Set();
  let stick = 0;
  let stickX = 0;
  for (const source of xrSession()?.inputSources ?? []) {
    const buttons = source.gamepad?.buttons;
    if (!buttons || source.hand) continue;
    if (buttons[3]?.pressed) held.add(`${source.handedness}-stick`);
    if (buttons[4]?.pressed) held.add(`${source.handedness}-a`);
    if (buttons[5]?.pressed) held.add(`${source.handedness}-b`);
    if (source.handedness === 'right') {
      stick = -(source.gamepad.axes[3] ?? 0);
      stickX = source.gamepad.axes[2] ?? 0;
    }
  }
  const pressed = (key) => held.has(key) && !xrButtonsHeld.has(key);
  // B opens the scene browser and closes it again, back to the scene. While a scene is still loading,
  // B gives up on it and goes straight back to the browser.
  if (pressed('right-b')) {
    const cancelled = cancelSceneLoad();
    if (!cancelled || !vrBrowser.isOpen) vrBrowser.toggle();
  }
  if (pressed('left-a') || pressed('left-b')) resetXrRig();
  if (pressed('right-stick')) vrBrowser.toggle();
  xrButtonsHeld = held;
  // Right stick left and right step through the scenes while the browser is closed.
  if (Math.abs(stickX) < STICK_RELEASE) {
    stickFlicked = false;
  } else if (!stickFlicked && Math.abs(stickX) > STICK_FLICK) {
    stickFlicked = true;
    if (!vrBrowser.isOpen) stepScene(Math.sign(stickX));
  }
  // While the browser is open the stick scrolls it, up and down as on the page.
  vrBrowser.setScrollStick(vrBrowser.isOpen && Math.abs(stick) > STICK_DEADZONE ? stick : 0);
  // Right stick up pushes the scene deeper, down pulls it back.
  if (currentMesh && !vrBrowser.isOpen && !stickFlicked && Math.abs(stick) > STICK_DEADZONE && Math.abs(stick) > Math.abs(stickX)) {
    const value = THREE.MathUtils.clamp(depthStretch.value + stick * STICK_STRETCH_SPEED * seconds,
      Number(offsetSlider.min), Number(offsetSlider.max));
    if (value !== depthStretch.value) setDepthStretch(value);
    // Shown at either end too, so pushing on shows that the limit is reached.
    vrBrowser.showDistance(depthStretch.value, Number(offsetSlider.min), Number(offsetSlider.max));
  }
}

function drawFpsHud(fps, averageMs, worstMs) {
  const { width, height } = fpsCanvas;
  const target = xrSession()?.frameRate || 72;
  fpsContext.clearRect(0, 0, width, height);
  fpsContext.fillStyle = 'rgba(0, 0, 0, 0.6)';
  fpsContext.beginPath();
  fpsContext.roundRect(0, 0, width, height, 28);
  fpsContext.fill();
  fpsContext.fillStyle = fps >= target * 0.95 ? '#5fdc7a' : fps >= target * 0.75 ? '#f2c94c' : '#ff6b6b';
  fpsContext.font = 'bold 88px system-ui, sans-serif';
  fpsContext.textBaseline = 'top';
  fpsContext.fillText(`${Math.round(fps)} FPS`, 28, 18);
  fpsContext.fillStyle = '#e8e8e8';
  fpsContext.font = '36px system-ui, sans-serif';
  fpsContext.fillText(`${averageMs.toFixed(1)} ms · worst ${worstMs.toFixed(1)} ms · target ${Math.round(target)}`, 28, 118);
  fpsContext.fillText(splatSummary(), 28, 166);
  fpsContext.fillStyle = '#b8b8b8';
  fpsContext.font = '32px system-ui, sans-serif';
  const [gpu, cpu] = timingSummary();
  fpsContext.fillText(gpu, 28, 220);
  fpsContext.fillText(cpu, 28, 264);
  fpsTexture.needsUpdate = true;
}

function timingSummary() {
  const frames = Math.max(1, fpsStats.frames);
  const frameCpu = `${(fpsStats.frameCpu / frames).toFixed(1)} ms`;
  if (!computeRenderer) return ['GPU time not measured', `CPU frame ${frameCpu}`];
  const { computeMs, drawMs, sortsPerSecond } = computeRenderer.stats;
  const gpu = computeMs === null ? 'GPU time not measured' : `GPU compute ${computeMs.toFixed(1)} · draw ${drawMs?.toFixed(1) ?? '–'} ms`;
  return [gpu, `CPU splats ${(fpsStats.splatCpu / frames).toFixed(1)} · frame ${frameCpu} · ${Math.round(sortsPerSecond)} sorts/s`];
}

function splatSummary() {
  const total = currentMesh?.packedSplats?.numSplats;
  const drawn = currentMesh?.numSplats ?? total;
  const path = computeRenderer ? 'Compute' : 'WebGL';
  return total ? `${path} · ${(drawn / 1e6).toFixed(2)} of ${(total / 1e6).toFixed(2)} M splats` : `${path} · no scene`;
}

// The flat view's meter in the toolbar; colours against a 60 Hz display.
function showFlatFrameStats(fps, averageMs, worstMs) {
  fpsValue.textContent = String(Math.round(fps));
  fpsValue.className = fps >= 57 ? 'good' : fps >= 45 ? 'fair' : 'poor';
  fpsTiming.textContent = ` FPS · ${averageMs.toFixed(1)} ms · max ${worstMs.toFixed(1)}`;
  fpsDetail.textContent = splatSummary();
  [fpsGpu.textContent, fpsCpu.textContent] = timingSummary();
}

// Frame times over half-second windows, shown on the headset's HUD in VR and in the toolbar otherwise.
function countFrame(time) {
  if (!fpsStats.windowStart) {
    Object.assign(fpsStats, { windowStart: time, lastTime: time, frames: 0, maxDelta: 0 });
    return;
  }
  fpsStats.maxDelta = Math.max(fpsStats.maxDelta, time - fpsStats.lastTime);
  fpsStats.lastTime = time;
  fpsStats.frames += 1;
  const elapsed = time - fpsStats.windowStart;
  if (elapsed < FPS_INTERVAL) return;
  const show = xrPresenting() ? drawFpsHud : showFlatFrameStats;
  if (debugMode) show((fpsStats.frames * 1000) / elapsed, elapsed / fpsStats.frames, fpsStats.maxDelta);
  Object.assign(fpsStats, { windowStart: time, frames: 0, maxDelta: 0, splatCpu: 0, frameCpu: 0 });
}

function setVrButtonState(presenting) {
  const label = presenting ? 'Exit VR' : 'View in VR';
  vrButton.setAttribute('aria-pressed', String(presenting));
  vrButton.setAttribute('aria-label', label);
  vrButton.title = label;
  vrButton.querySelector('span').textContent = presenting ? 'Exit VR' : 'VR';
}

const sparkXr = gpuXr ? null : new SparkXr({
  renderer,
  element: vrButton,
  mode: 'vr',
  // Lets the scene browser use native quad layers, which stay sharp where foveation lowers the resolution.
  sessionInit: { optionalFeatures: ['layers'] },
  // Full resolution in the middle of the view; fixed foveation renders the edges with fewer pixels.
  frameBufferScaleFactor: 1,
  fixedFoveation: 1,
  // The right stick sets the depth stretch instead of turning.
  controllers: { moveSpeed: 1.5, moveDirection: true, getRotate: () => new THREE.Vector3() },
  onReady: (supported) => { vrButton.hidden = !supported; },
});

function startXr() {
  xrSavedView = {
    sceneId: activeSceneId, position: camera.position.clone(), target: controls.target.clone(), stretch: depthStretch.value,
  };
  placeXrRig();
  controls.enabled = false;
  if (sparkXr) sparkXr.lastControllersUpdate = 0;
  xrButtonsHeld = new Set();
  xrLastFrameTime = 0;
  fpsStats.windowStart = 0;
  fpsContext.clearRect(0, 0, fpsCanvas.width, fpsCanvas.height);
  fpsTexture.needsUpdate = true;
  fpsHud.visible = debugMode;
  stickFlicked = false;
  vrBrowser.setPresenting(true);
  if (xrOpenBrowserOnStart && !vrBrowser.isOpen) vrBrowser.toggle();
  xrOpenBrowserOnStart = false;
  Object.assign(spark, SPARK_XR);
  setVrButtonState(true);
}

function endXr() {
  resetXrRig();
  fpsHud.visible = false;
  fpsStats.windowStart = 0;
  vrBrowser.setPresenting(false);
  Object.assign(spark, SPARK_DESKTOP);
  controls.enabled = true;
  if (xrSavedView && xrSavedView.sceneId === activeSceneId) {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    camera.position.copy(xrSavedView.position);
    camera.up.set(0, 1, 0);
    // The right stick may have changed the stretch in VR; keep the orbit on the stretched focus.
    controls.target.copy(xrSavedView.target)
      .addScaledVector(STRETCH_AXIS, stretchedFocus(depthStretch.value) - stretchedFocus(xrSavedView.stretch));
    controls.update();
    controls.enableDamping = damping;
  } else {
    resetCamera();
  }
  xrSavedView = null;
  setVrButtonState(false);
  resize();
  // Left VR without choosing a scene in the browser: show the first one on the screen.
  if (!requestedScene && scenes.length) void selectScene(scenes[0].id);
}

renderer.xr.addEventListener('sessionstart', startXr);
renderer.xr.addEventListener('sessionend', endXr);

// Speeds of the left stick, as on the WebGL path: right trigger runs, right grip creeps.
const XR_MOVE_SPEED = 1.5;
const xrMove = new THREE.Vector3();
const xrHeadQuaternion = new THREE.Quaternion();
const xrHeadYaw = new THREE.Euler();

// Left stick walks along the floor in the direction the head faces; left trigger and grip rise and sink.
function moveXrRig(seconds) {
  let left = null;
  let right = null;
  for (const source of xrSession()?.inputSources ?? []) {
    if (!source.gamepad || source.hand) continue;
    if (source.handedness === 'left') left = source.gamepad;
    if (source.handedness === 'right') right = source.gamepad;
  }
  if (!left) return;
  xrMove.set(left.axes[2] ?? 0, (left.buttons[0]?.value ?? 0) - (left.buttons[1]?.value ?? 0), left.axes[3] ?? 0);
  if (xrMove.lengthSq() < 1e-4) return;
  let speed = XR_MOVE_SPEED;
  if (right?.buttons[0]?.pressed) speed *= 5;
  if (right?.buttons[1]?.pressed) speed /= 5;
  xrHeadYaw.setFromQuaternion(xrHeadQuaternion.setFromRotationMatrix(gpuXr.headLocal), 'YXZ');
  xrHeadQuaternion.setFromEuler(xrHeadYaw.set(0, xrHeadYaw.y, 0, 'YXZ'));
  xrRig.position.add(xrMove.applyQuaternion(xrHeadQuaternion).applyQuaternion(xrRig.quaternion).multiplyScalar(seconds * speed));
}

// One VR frame on WebGPU: input and interface first, then the splats and the interface on top.
function gpuXrFrame(time) {
  const frameStart = performance.now();
  const seconds = xrLastFrameTime ? Math.min((time - xrLastFrameTime) / 1000, 0.1) : 0;
  xrLastFrameTime = time;
  countFrame(time);
  scene.updateMatrixWorld();
  // The browser panel stays put in the room, so the sticks do not move the user while it is open.
  if (!vrBrowser.isOpen) moveXrRig(seconds);
  handleXrInput(seconds);
  vrBrowser.update();
  const splats = currentMesh?.isComputeSplats && currentMesh.visible ? currentMesh : null;
  const splatStart = performance.now();
  gpuXr.render({
    mesh: splats,
    startView: splats?.userData.startView,
    depthRange: splats?.userData.depthRange,
    stretch: depthStretch.value,
    depthColors: depthEnabled,
    // The open view around the scene glows in its colours, as behind the flat view.
    ambilight: true,
  }, [[fpsHud, fpsHudOffset]]);
  fpsStats.splatCpu += performance.now() - splatStart;
  fpsStats.frameCpu += performance.now() - frameStart;
}

if (gpuXr) {
  gpuXr.onStart = startXr;
  gpuXr.onEnd = endXr;
  gpuXr.onFrame = gpuXrFrame;
  vrButton.hidden = false;
  vrButton.addEventListener('click', () => {
    if (gpuXr.presenting) {
      gpuXr.end();
      return;
    }
    gpuXr.start().catch((error) => {
      console.error(error);
      showToast(`Could not start VR on WebGPU: ${error.message}`, true);
    });
  });
}

// "Open VR" on the start page lands here with ?vr. Browsers only start VR from a click on this page,
// so one large button asks for that click. VR then opens in the scene browser, and no scene loads
// before one is chosen there.
const vrStart = $('#vr-start');
const vrBrowserStart = new URLSearchParams(location.search).has('vr') && immersiveVr;
if (new URLSearchParams(location.search).has('vr')) {
  if (immersiveVr) vrStart.hidden = false;
  else showToast('No VR headset found. The viewer stays on the screen.', true);
}
$('#vr-start-button').addEventListener('click', () => {
  vrStart.hidden = true;
  xrOpenBrowserOnStart = true;
  vrButton.click();
});
$('#vr-start-dismiss').addEventListener('click', () => {
  vrStart.hidden = true;
  if (!requestedScene && scenes.length) void selectScene(scenes[0].id);
});

// Red-cyan view for classic 3D glasses (red over the left eye) and webcam head tracking in the flat
// view. Both draw through the screen as a window; see screen-views.js.
const anaglyphButton = $('#anaglyph-button');
const headButton = $('#head-button');
const PAGE_BACKGROUND = 0x151515;
const pageBackgroundRgb = new THREE.Color(PAGE_BACKGROUND).toArray();
const screenViews = new ScreenViews();
const headTracker = new HeadTracker();
const webGlAnaglyph = computeRenderer ? null : new WebGlAnaglyph(renderer, PAGE_BACKGROUND);
let anaglyphEnabled = false;
let flatLastFrameTime = 0;
const eyePosition = new THREE.Vector3();

anaglyphButton.addEventListener('click', () => {
  anaglyphEnabled = !anaglyphEnabled;
  anaglyphButton.setAttribute('aria-pressed', String(anaglyphEnabled));
});
headButton.hidden = !navigator.mediaDevices?.getUserMedia;
headButton.addEventListener('click', async () => {
  if (headTracker.active) {
    headTracker.stop();
    headButton.setAttribute('aria-pressed', 'false');
    return;
  }
  headButton.disabled = true;
  try {
    await headTracker.start();
    headButton.setAttribute('aria-pressed', 'true');
    showToast('Head tracking is on. Sit as you usually do for a moment: that becomes the middle.');
  } catch (error) {
    console.warn(error);
    showToast(`Head tracking could not start: ${error.message}`, true);
  } finally {
    headButton.disabled = false;
  }
});

// The cameras the flat view draws from this frame: the orbit camera itself, or one or two eyes looking
// through the screen when the red-cyan view or the head tracker is on.
function flatEyes(time) {
  const seconds = flatLastFrameTime ? Math.min((time - flatLastFrameTime) / 1000, 0.1) : 0;
  flatLastFrameTime = time;
  const head = headTracker.update(seconds);
  if (renderer.xr.isPresenting || (!anaglyphEnabled && !head)) return [camera];
  return screenViews.update(camera, camera.position.distanceTo(controls.target), head, anaglyphEnabled);
}

resetCamera();
new ResizeObserver(resize).observe(stage);
resize();
renderer.setAnimationLoop((time) => {
  // A WebGPU VR session draws in its own frame loop.
  if (gpuXr?.presenting) return;
  countFrame(time);
  if (renderer.xr.isPresenting) {
    const seconds = xrLastFrameTime ? Math.min((time - xrLastFrameTime) / 1000, 0.1) : 0;
    xrLastFrameTime = time;
    // The browser panel stays put in the room, so the sticks do not move the user while it is open.
    if (!vrBrowser.isOpen) sparkXr?.updateControllers(camera);
    handleXrInput(seconds);
    vrBrowser.update();
  } else if (controls.enabled) {
    controls.update();
  }
  const eyes = flatEyes(time);
  const splatStart = performance.now();
  drawComputeSplats(eyes);
  const frameStart = performance.now();
  if (eyes.length === 2 && webGlAnaglyph) webGlAnaglyph.render(scene, eyes);
  else renderer.render(scene, eyes[0]);
  fpsStats.splatCpu += frameStart - splatStart;
  fpsStats.frameCpu += performance.now() - frameStart;
  // The drawing buffer is only readable right after rendering.
  updateAmbilight();
  if (thumbnailRequest && !renderer.xr.isPresenting && performance.now() >= thumbnailRequest.at) captureThumbnail();
});

// Copies the splats of the frame just drawn into the ambilight. The splats are on the compute
// renderer's canvas, or on the WebGL one with Spark.
function updateAmbilight() {
  if (!ambilight || renderer.xr.isPresenting) return;
  const source = computeRenderer ? (computeRenderer.canvas.hidden ? null : computeRenderer.canvas) : renderer.domElement;
  // The glow would sit on the screen in both eyes' colours, so the red-cyan view goes without it.
  ambilight.update(currentMesh?.visible && !anaglyphEnabled ? source : null);
}

// Renders the flat view's splats into the WebGPU canvas under the WebGL one, in the same frame.
function drawComputeSplats(eyes) {
  if (!computeRenderer) return;
  const splats = currentMesh?.isComputeSplats && currentMesh.visible ? currentMesh : null;
  computeRenderer.canvas.hidden = !splats;
  if (!splats || computeRenderer.lost) return;
  renderer.getDrawingBufferSize(drawingBufferSize);
  camera.updateMatrixWorld();
  // Sorted from between the eyes.
  sortOrigin.set(0, 0, 0);
  for (const eye of eyes) sortOrigin.add(eyePosition.setFromMatrixPosition(eye.matrixWorld));
  sortOrigin.divideScalar(eyes.length);
  splats.updateMatrixWorld();
  const options = {
    model: splats.matrixWorld,
    views: eyes.map((eye) => ({
      view: eye.matrixWorldInverse,
      projection: eye.projectionMatrix,
      viewport: fullViewport.set(0, 0, drawingBufferSize.x, drawingBufferSize.y),
    })),
    width: drawingBufferSize.x,
    height: drawingBufferSize.y,
    origin: sortOrigin,
    startView: splats.userData.startView,
    depthRange: splats.userData.depthRange,
    stretch: depthStretch.value,
    depthColors: depthEnabled,
  };
  if (eyes.length === 2) computeRenderer.renderAnaglyph(splats.gpu, { ...options, background: pageBackgroundRgb });
  else computeRenderer.render(splats.gpu, options);
}

function requestThumbnail(item, mesh) {
  thumbnailRequest?.done();
  thumbnailRequest = null;
  if (!mesh || item.file || item.thumbUrl) return;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  thumbnailRequest = { item, mesh, at: performance.now() + THUMBNAIL_DELAY, done, finished };
}

function captureThumbnail() {
  const { item, mesh, done } = thumbnailRequest;
  thumbnailRequest = null;
  // Thumbnails show a scene as it first opens: no depth colours, default stretch.
  if (mesh !== currentMesh || depthEnabled || depthStretch.value !== DEFAULT_DEPTH_STRETCH || anaglyphEnabled || headTracker.active) {
    done();
    return;
  }
  const source = renderer.domElement;
  // The compute renderer's splats are on their own canvas under the WebGL one.
  const layers = computeRenderer ? [computeRenderer.canvas, source] : [source];
  const thumbnail = document.createElement('canvas');
  thumbnail.width = THUMBNAIL_WIDTH;
  thumbnail.height = THUMBNAIL_HEIGHT;
  const context2d = thumbnail.getContext('2d');
  context2d.fillStyle = '#151515';
  context2d.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const scale = Math.max(THUMBNAIL_WIDTH / source.width, THUMBNAIL_HEIGHT / source.height);
  const width = THUMBNAIL_WIDTH / scale;
  const height = THUMBNAIL_HEIGHT / scale;
  for (const layer of layers) {
    context2d.drawImage(layer, (source.width - width) / 2, (source.height - height) / 2, width, height, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  }
  thumbnail.toBlob(async (blob) => {
    try {
      const response = await fetch(`/api/thumbnail?scene=${encodeURIComponent(item.id)}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
      if (response.ok) item.thumbUrl = (await response.json()).thumbUrl;
    } catch {}
    done();
  }, 'image/jpeg', 0.82);
}

// Opened from the scene browser: walk through every scene that has no thumbnail yet.
async function createMissingThumbnails() {
  setDepthEnabled(false);
  const missing = scenes.filter((item) => !item.thumbUrl);
  let created = 0;
  for (const [index, item] of missing.entries()) {
    showToast(`Creating thumbnails · ${index + 1} / ${missing.length}`);
    if (!(await selectScene(item.id))) continue;
    await thumbnailRequest?.finished;
    if (item.thumbUrl) created += 1;
  }
  showToast(`Created ${created} ${created === 1 ? 'thumbnail' : 'thumbnails'}.`);
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
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
  offsetControl.hidden = false;
  $('#scene-name').textContent = item.name;
  $('#scene-name').title = item.name;
  if (item.imageUrl) compareOriginal.src = item.imageUrl;
  else compareOriginal.removeAttribute('src');
  if (!item.imageUrl) setCompareEnabled(false);
}

function updateSceneListSelection() {
  updateScenePosition();
  vrBrowser.setScenes(allScenes(), activeSceneId);
}

function updateScenePosition() {
  const order = sceneOrder();
  const currentIndex = order.indexOf(activeSceneId);
  $('#scene-position').textContent = currentIndex < 0 ? '' : `${currentIndex + 1} / ${order.length}`;
  $('#scene-stepper').hidden = order.length < 2;
}

// A folder's own scenes before those of its subfolders, as the scene browsers list them.
function folderScenes(node) {
  return [...node.scenes, ...node.folders.flatMap(folderScenes)];
}

// The order the arrows and the VR stick step through: the scene browser's, with its sort, remembered
// by the grid page and the VR panel.
function sceneOrder() {
  return browserOrder(allScenes(), savedSort()).map((item) => item.id);
}

// The folder button of the empty view, and the scene position.
function updateSceneOrder() {
  for (const button of document.querySelectorAll('.folder-button')) button.hidden = library?.canChooseFolder === false;
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

function stepScene(direction) {
  const currentId = requestedScene?.id ?? activeSceneId;
  const order = sceneOrder();
  if (!order.length) return;
  const currentIndex = order.indexOf(currentId);
  const nextIndex = (currentIndex + direction + order.length) % order.length;
  void selectScene(order[nextIndex]);
}

function showLibrary(data) {
  library = data;
  // The server started with --debug turns the frame-rate displays on.
  debugMode = !!data.debug;
  $('#fps-meter').hidden = !debugMode;
  scenes = library.tree ? folderScenes(library.tree) : [];
  updateSceneOrder();
}

async function fetchScenes() {
  const response = await fetch('/api/scenes', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load scenes.');
  showLibrary(await response.json());
}

// Opening the VR scene browser looks for scenes added to the folder since; it updates when the answer is in.
let scenesRefresh = null;
function refreshScenes() {
  scenesRefresh ??= fetchScenes().catch((error) => console.warn(error)).finally(() => { scenesRefresh = null; });
}

function cacheScene(id, mesh) {
  sceneCache.delete(id);
  sceneCache.set(id, mesh);
  let total = 0;
  for (const cached of sceneCache.values()) total += cached.packedSplats.numSplats;
  for (const [oldId, old] of sceneCache) {
    if (total <= SCENE_CACHE_SPLATS) break;
    // The scene on screen and the one just added always stay.
    if (old === mesh || old === currentMesh) continue;
    sceneCache.delete(oldId);
    total -= old.packedSplats.numSplats;
    old.dispose();
  }
}

function showLoading(item, phase, loaded = 0, total = 0) {
  loadingPanel.hidden = false;
  loadingDetail.textContent = phase === 'prepare' ? 'Preparing detail levels …'
    : total ? `Loading scene · ${Math.min(100, Math.round((loaded / total) * 100))} %` : 'Loading scene …';
  vrBrowser.setLoading({ item, phase, loaded, total });
}

function hideLoading() {
  loadingPanel.hidden = true;
  vrBrowser.setLoading(null);
}

// Stops loading the requested scene; the scene on screen stays. Returns whether a load was running.
function cancelSceneLoad() {
  if (!requestedScene || requestedScene.id === activeSceneId) return false;
  loadVersion += 1;
  loadAbort?.abort();
  loadAbort = null;
  requestedScene = allScenes().find((entry) => entry.id === activeSceneId) ?? null;
  hideLoading();
  $('#viewer-empty').hidden = !!currentMesh;
  return true;
}

function clearScene() {
  loadVersion += 1;
  loadAbort?.abort();
  cancelPrefetches();
  hideLoading();
  if (currentMesh) scene.remove(currentMesh);
  for (const mesh of sceneCache.values()) mesh.dispose();
  sceneCache.clear();
  currentMesh = null;
  activeSceneId = null;
  requestedScene = null;
  $('#download-link').hidden = true;
  compareButton.hidden = true;
  depthButton.hidden = true;
  offsetControl.hidden = true;
  $('#scene-name').textContent = '';
  ratingPanel.leave();
  ratingPanel.setScene(null);
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
    // Scene ids are paths inside the folder, so cached scenes from the old folder must go.
    clearScene();
    showLibrary(data);
    if (scenes.length) await selectScene(scenes[0].id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

// The level-of-detail tree lets VR draw only as many splats as the headset can handle. It is built
// in a worker in the background, so the desktop view does not wait for it.
function buildDetailLevels(packedSplats) {
  if (!detailBuilds.has(packedSplats)) {
    detailBuilds.set(packedSplats, packedSplats.createLodSplats().catch((error) => console.error(error)));
  }
  return detailBuilds.get(packedSplats);
}

async function loadPackedSplats(item, version, signal) {
  const packedSplats = await readPackedSplats(item, signal, (loaded, total) => {
    if (version === loadVersion) showLoading(item, 'download', loaded, total);
  });
  // The compute renderer culls on the GPU and draws every splat, so it needs no detail levels.
  if (computeRenderer) return packedSplats;
  const detail = buildDetailLevels(packedSplats);
  if (renderer.xr.isPresenting && version === loadVersion) {
    showLoading(item, 'prepare');
    await detail;
  }
  return packedSplats;
}

// Fetched by hand rather than with Spark's loader so a download can be cancelled when the user
// skips on to another scene before it finishes.
async function fetchSplatBytes(item, signal, onProgress) {
  const response = await fetch(item.plyUrl, { signal });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  const total = Number(response.headers.get('Content-Length')) || item.sizeBytes;
  const chunks = [];
  let loaded = 0;
  for (const reader = response.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readPackedSplats(item, signal, onProgress) {
  const fileBytes = item.file ? new Uint8Array(await item.file.arrayBuffer()) : await fetchSplatBytes(item, signal, onProgress);
  const packedSplats = new PackedSplats({ fileBytes, fileName: item.fileName });
  await packedSplats.initialized;
  return packedSplats;
}

function createSceneMesh(packedSplats) {
  const mesh = computeRenderer ? new ComputeSplats(computeRenderer, packedSplats) : new SplatMesh({ packedSplats });
  mesh.quaternion.set(1, 0, 0, 0);
  return mesh;
}

// The scenes before and after the current one load in the background, one after the other once the
// current one is on screen, so stepping to them is instant. Their downloads and parsing run off the
// main thread; everything measured on the main thread waits until a scene is shown.
const prefetches = new Map();

function cancelPrefetches(keep = []) {
  for (const [id, job] of prefetches) {
    if (keep.includes(id)) continue;
    job.abort.abort();
    prefetches.delete(id);
  }
}

function prefetchNeighbors() {
  const order = sceneOrder();
  const index = order.indexOf(activeSceneId);
  const count = order.length;
  if (index < 0 || count < 2) return;
  const wanted = [...new Set([order[(index + 1) % count], order[(index - 1 + count) % count]])];
  cancelPrefetches(wanted);
  let previous = Promise.resolve();
  for (const id of wanted) {
    if (sceneCache.has(id) || prefetches.has(id)) continue;
    const item = allScenes().find((entry) => entry.id === id);
    if (!item) continue;
    const abort = new AbortController();
    const promise = previous.then(async () => {
      if (abort.signal.aborted) return null;
      const packedSplats = await readPackedSplats(item, abort.signal);
      if (!computeRenderer) await buildDetailLevels(packedSplats);
      if (abort.signal.aborted) {
        packedSplats.dispose?.();
        return null;
      }
      const mesh = createSceneMesh(packedSplats);
      cacheScene(id, mesh);
      return mesh;
    }).catch(() => null).finally(() => {
      if (prefetches.get(id)?.abort === abort) prefetches.delete(id);
    });
    prefetches.set(id, { abort, promise });
    previous = promise;
  }
}

async function selectScene(id) {
  const item = allScenes().find((entry) => entry.id === id);
  if (!item) return false;
  const version = ++loadVersion;
  loadAbort?.abort();
  loadAbort = null;
  requestedScene = item;
  if (activeSceneId === id && currentMesh) {
    hideLoading();
    return true;
  }
  // Downloads for scenes in the background give way, unless it is this very scene.
  cancelPrefetches([id]);
  let mesh = sceneCache.get(id);
  $('#viewer-empty').hidden = true;
  if (mesh) hideLoading();
  else showLoading(item, 'download');
  try {
    // Already loading in the background: wait for that rather than starting over.
    if (!mesh && prefetches.has(id)) {
      mesh = await prefetches.get(id).promise;
      if (version !== loadVersion) return false;
    }
    if (!mesh) {
      loadAbort = new AbortController();
      const packedSplats = await loadPackedSplats(item, version, loadAbort.signal);
      if (version !== loadVersion) {
        packedSplats.dispose?.();
        return false;
      }
      mesh = createSceneMesh(packedSplats);
    }
    mesh.userData.focusDistance ??= measureFocusDistance(mesh.packedSplats);
    mesh.visible = !vrBrowser.isOpen;
    // The scene before keeps the distance it has now in its rating.
    if (activeSceneId !== id) ratingPanel.leave();
    scene.add(mesh);
    if (currentMesh) scene.remove(currentMesh);
    currentMesh = mesh;
    cacheScene(id, mesh);
    activeSceneId = id;
    updateSceneListSelection();
    updateSceneActions(item);
    resetCamera();
    if (!mesh.userData.startView) {
      rememberStartView(mesh);
      mesh.userData.depthRange = measureDepthRange(mesh);
    }
    // Every scene starts at distance ×1.
    setDepthStretch(DEFAULT_DEPTH_STRETCH, false);
    ratingPanel.setScene(item);
    resetCamera();
    setDepthEnabled(depthEnabled);
    if (xrPresenting()) resetXrRig();
    hideLoading();
    history.replaceState(null, '', item.file ? location.pathname : `?scene=${encodeURIComponent(id)}`);
    requestThumbnail(item, mesh);
    prefetchNeighbors();
    return true;
  } catch (error) {
    if (version !== loadVersion) return false;
    requestedScene = allScenes().find((entry) => entry.id === activeSceneId) ?? null;
    loadingPanel.hidden = true;
    vrBrowser.setLoading({ item, phase: 'error', message: error.message });
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
    updateSceneOrder();
  }
  void selectScene(id);
}

$('#open-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  openLocalFile(fileInput.files?.[0]);
  fileInput.value = '';
});
for (const button of document.querySelectorAll('.folder-button')) button.addEventListener('click', () => chooseFolder());
compareButton.addEventListener('click', () => setCompareEnabled(!compareEnabled));
depthButton.addEventListener('click', () => setDepthEnabled(!depthEnabled));
offsetSlider.addEventListener('input', () => setDepthStretch(Number(offsetSlider.value)));
offsetSlider.addEventListener('dblclick', () => setDepthStretch(DEFAULT_DEPTH_STRETCH));
setDepthStretch(DEFAULT_DEPTH_STRETCH, false);
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
$('#reset-view').addEventListener('click', () => (xrPresenting() ? resetXrRig() : resetCamera()));

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

// Arrow keys step through the scenes, 0 to 5 give the scene that score; the same key again clears it.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.target.closest?.('input, select, textarea, [contenteditable], [role="slider"]')) return;
  if (/^[0-5]$/.test(event.key)) {
    ratingPanel.rate(Number(event.key));
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (sceneOrder().length < 2) return;
  event.preventDefault();
  stepScene(event.key === 'ArrowRight' ? 1 : -1);
});

const rendererButton = $('#renderer-button');
rendererButton.querySelector('span').textContent = computeRenderer ? 'Compute' : 'WebGL';
rendererButton.title = computeRenderer ? 'Splats render with WebGPU compute shaders. Switch to Spark on WebGL.'
  : 'Splats render with Spark on WebGL. Switch to WebGPU compute shaders.';
rendererButton.addEventListener('click', () => {
  const params = new URLSearchParams(location.search);
  params.set('renderer', computeRenderer ? 'webgl' : 'compute');
  location.search = params.toString();
});
if (computeUnavailable) showToast(`The compute renderer is not available here: ${computeUnavailable}. Using the WebGL renderer.`, true);

try {
  await fetchScenes();
  const params = new URLSearchParams(location.search);
  const requested = params.get('scene');
  if (params.has('thumbnails') && scenes.some((item) => !item.thumbUrl)) await createMissingThumbnails();
  else if (scenes.length && vrBrowserStart && !scenes.some((item) => item.id === requested)) {
    // The scene is chosen in the VR browser.
  } else if (scenes.length) await selectScene(scenes.some((item) => item.id === requested) ? requested : scenes[0].id);
  else $('#viewer-empty').hidden = false;
} catch (error) {
  $('#viewer-empty').hidden = false;
  showToast(error.message, true);
}
