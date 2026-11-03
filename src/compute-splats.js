import * as THREE from 'three';
import { ANAGLYPH_LEFT, ANAGLYPH_RIGHT } from './screen-views.js';

// Gaussian splats rendered with WebGPU compute shaders, as an alternative to Spark's WebGL path.
//
// Every frame a compute pass projects each splat into each eye, culls what is off screen or too faint,
// and compacts the visible splats into a draw list, all on the GPU. The splats are kept sorted by
// distance from the head with a GPU radix sort; that order does not change when the head only turns,
// so sorting runs only after the head has moved. A single indirect draw then blends the visible
// splats back to front, which is the one step mobile GPUs do fastest in fixed-function hardware.
//
// In VR the splats are foveated by hand, since the headset ignores fixed foveation on WebGPU layers:
// they are drawn into a smaller, warped image whose pixels are as dense as the eye's at the lens
// centre and thin out towards the edge, and the eye's pass spreads that image back out.
//
// With the ambilight on, the open view around the splats in VR takes on their colours, as the
// ambilight does behind the flat view (ambilight.js): the warped image is mipmapped, a small glow image
// is made from its levels and blurred, and the eye's pass lays the glow under the splats.
//
// The flat view shows the WebGPU canvas in the page, under the transparent WebGL canvas that carries
// everything else; the browser composites both in the same frame. In VR the splats go straight into
// the headset's image (webgpu-xr.js).

const WORKGROUP_SIZE = 256;
const SORT_ITEMS_PER_THREAD = 4;
const SORT_BLOCK = WORKGROUP_SIZE * SORT_ITEMS_PER_THREAD;
const SORT_PASSES = 4;
const SORT_BITS = 4;
const SORT_BINS = 1 << SORT_BITS;
// Head movement, in scene units, before the depth order is refreshed.
const RESORT_DISTANCE = 0.01;
// Change of the depth stretch before the order is refreshed. The stick changes it a little every
// frame, and sorting all splats every frame costs the headset its frame rate.
const RESORT_STRETCH = 0.05;
const MAX_PIXEL_RADIUS = 1024;
// The ambilight in VR, as in ambilight.js: the finest level it uses is about this wide, it is this
// bright next to the scene, and its glow image has this fraction of the warped image's width.
const AMBILIGHT_FINEST_WIDTH = '160.0';
const AMBILIGHT_BRIGHTNESS = '0.8';
const GLOW_SCALE = 1 / 8;
const GLOW_FORMAT = 'rgba16float';
const STATS_INTERVAL_MS = 500;
const FRAME_BYTES = 400;

const DEFAULT_ENCODING = { rgbMin: 0, rgbMax: 1, lnScaleMin: -12, lnScaleMax: 9, lodOpacity: false };

const FRAME_WGSL = /* wgsl */ `
struct Frame {
  modelView: array<mat4x4<f32>, 2>,
  projection: array<mat4x4<f32>, 2>,
  // x, y, width, height in pixels, from the top left.
  viewport: array<vec4<f32>, 2>,
  // Where the splats are sorted from, in splat space.
  sortOrigin: vec4<f32>,
  // Row of the start view that gives a splat's depth: dot(vec4(center, 1), startAxis).
  startAxis: vec4<f32>,
  // near, far, stretch, depth colours on (1) or off (0).
  depth: vec4<f32>,
  // rgbMin, rgbMax, lnScaleMin, lnScaleMax of Spark's packed encoding.
  encoding: vec4<f32>,
  // splat count, eye count, doubled opacity (1) or not (0), ambilight in VR (1) or not (0).
  counts: vec4<u32>,
  // Per eye: lens centre x and y in NDC, foveation strength (0 is off), unused.
  foveation: array<vec4<f32>, 2>,
}

@group(0) @binding(0) var<uniform> frame: Frame;

// Foveated warp along one axis: keeps -1, the lens centre c and 1 in place, magnifies by 1 + strength
// at c and falls off smoothly to (1 - strength) / (1 + strength) at the edge, straight on beyond it.
// The warped image is 1 + strength times smaller, so its pixels match the eye's at the centre.
// Returns the warped coordinate and its derivative.
fn warpAxis(x: f32, c: f32, strength: f32) -> vec2<f32> {
  let side = select(1.0 + c, 1.0 - c, x >= c);
  let u = (x - c) / side;
  let t = min(abs(u), 1.0);
  let k = 1.0 + strength * t * t;
  let slope = (1.0 + strength) * (1.0 - strength * t * t) / (k * k);
  let warped = t * (1.0 + strength) / k + slope * max(abs(u) - 1.0, 0.0);
  return vec2(c + sign(u) * side * warped, slope);
}

fn startDepth(center: vec3<f32>) -> f32 {
  return dot(vec4(center, 1.0), frame.startAxis);
}

// Pushes splats away from the start view in proportion to how far they lie behind the nearest surface.
fn stretched(center: vec3<f32>) -> vec3<f32> {
  return center + frame.startAxis.xyz * max(startDepth(center) - frame.depth.x, 0.0) * frame.depth.z;
}

fn splatCenter(word: vec4<u32>) -> vec3<f32> {
  return vec3(unpack2x16float(word.y), unpack2x16float(word.z).x);
}
`;

// Spark's 16-byte PackedSplats layout: rgba8, half-float centre, log-encoded 8-bit scales and an
// octahedral axis with an 8-bit angle for the rotation.
const DECODE_WGSL = /* wgsl */ `
struct Splat {
  center: vec3<f32>,
  scales: vec3<f32>,
  quaternion: vec4<f32>,
  color: vec4<f32>,
}

fn decodeSplat(word: vec4<u32>) -> Splat {
  var splat: Splat;
  let rgba = unpack4x8unorm(word.x);
  let opacity = select(rgba.a, 2.0 * rgba.a, frame.counts.z != 0u);
  splat.color = vec4(frame.encoding.x + rgba.rgb * (frame.encoding.y - frame.encoding.x), opacity);
  splat.center = splatCenter(word);
  let steps = vec3<u32>(word.w & 255u, (word.w >> 8u) & 255u, (word.w >> 16u) & 255u);
  let lnScale = frame.encoding.z + (vec3<f32>(steps) - 1.0) * (frame.encoding.w - frame.encoding.z) / 254.0;
  splat.scales = select(exp(lnScale), vec3(0.0), steps == vec3(0u));
  let encoded = (word.z >> 16u) | ((word.w >> 8u) & 0xff0000u);
  var octahedral = vec2(f32(encoded & 255u), f32((encoded >> 8u) & 255u)) / 255.0 * 2.0 - 1.0;
  let z = 1.0 - abs(octahedral.x) - abs(octahedral.y);
  let fold = max(-z, 0.0);
  octahedral += select(vec2(fold), vec2(-fold), octahedral >= vec2(0.0));
  let axis = normalize(vec3(octahedral, z));
  let halfAngle = f32((encoded >> 16u) & 255u) / 255.0 * 1.5707963;
  splat.quaternion = vec4(axis * sin(halfAngle), cos(halfAngle));
  return splat;
}

fn covariance(scales: vec3<f32>, q: vec4<f32>) -> mat3x3<f32> {
  let rotation = mat3x3<f32>(
    1.0 - 2.0 * (q.y * q.y + q.z * q.z), 2.0 * (q.x * q.y + q.w * q.z), 2.0 * (q.x * q.z - q.w * q.y),
    2.0 * (q.x * q.y - q.w * q.z), 1.0 - 2.0 * (q.x * q.x + q.z * q.z), 2.0 * (q.y * q.z + q.w * q.x),
    2.0 * (q.x * q.z + q.w * q.y), 2.0 * (q.y * q.z - q.w * q.x), 1.0 - 2.0 * (q.x * q.x + q.y * q.y),
  );
  let m = rotation * mat3x3<f32>(scales.x, 0.0, 0.0, 0.0, scales.y, 0.0, 0.0, 0.0, scales.z);
  return m * transpose(m);
}
`;

const KEYS_WGSL = /* wgsl */ `${FRAME_WGSL}
@group(0) @binding(1) var<storage, read> splats: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> values: array<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= frame.counts.x) {
    return;
  }
  let dist = length(stretched(splatCenter(splats[index])) - frame.sortOrigin.xyz);
  // Log distance in 16 bits, far splats first: 1 mm to about 1 km, about 0.02 % apart.
  let t = clamp(log2(max(dist, 0.001) * 1000.0) / 20.0, 0.0, 1.0);
  keys[index] = 65535u - u32(round(t * 65535.0));
  values[index] = index;
}
`;

const SORT_PARAMS_WGSL = /* wgsl */ `
struct SortParams {
  shift: u32,
  count: u32,
  blocks: u32,
  unused: u32,
}

@group(0) @binding(0) var<uniform> params: SortParams;
`;

const SORT_COUNT_WGSL = /* wgsl */ `${SORT_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> keysIn: array<u32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<u32>;

var<workgroup> digitCounts: array<atomic<u32>, ${SORT_BINS}>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(local_invocation_index) local: u32, @builtin(workgroup_id) block: vec3<u32>) {
  if (local < ${SORT_BINS}u) {
    atomicStore(&digitCounts[local], 0u);
  }
  workgroupBarrier();
  for (var chunk = 0u; chunk < ${SORT_ITEMS_PER_THREAD}u; chunk++) {
    let index = block.x * ${SORT_BLOCK}u + chunk * ${WORKGROUP_SIZE}u + local;
    if (index < params.count) {
      atomicAdd(&digitCounts[(keysIn[index] >> params.shift) & ${SORT_BINS - 1}u], 1u);
    }
  }
  workgroupBarrier();
  if (local < ${SORT_BINS}u) {
    histogram[local * params.blocks + block.x] = atomicLoad(&digitCounts[local]);
  }
}
`;

// Stable scatter: within a block, elements keep their order. Each round marks every thread's digit in
// a 256-bit mask per digit, so a thread's rank is the number of marked bits before its own.
const SORT_SCATTER_WGSL = /* wgsl */ `${SORT_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> keysIn: array<u32>;
@group(0) @binding(2) var<storage, read> valuesIn: array<u32>;
@group(0) @binding(3) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(4) var<storage, read_write> valuesOut: array<u32>;
@group(0) @binding(5) var<storage, read> histogram: array<u32>;

const WORDS = ${WORKGROUP_SIZE / 32}u;
var<workgroup> masks: array<atomic<u32>, ${SORT_BINS * (WORKGROUP_SIZE / 32)}>;
var<workgroup> offsets: array<u32, ${SORT_BINS}>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(local_invocation_index) local: u32, @builtin(workgroup_id) block: vec3<u32>) {
  if (local < ${SORT_BINS}u) {
    offsets[local] = histogram[local * params.blocks + block.x];
  }
  if (local < ${SORT_BINS}u * WORDS) {
    atomicStore(&masks[local], 0u);
  }
  workgroupBarrier();
  let word = local / 32u;
  let bit = 1u << (local % 32u);
  for (var chunk = 0u; chunk < ${SORT_ITEMS_PER_THREAD}u; chunk++) {
    let index = block.x * ${SORT_BLOCK}u + chunk * ${WORKGROUP_SIZE}u + local;
    let valid = index < params.count;
    var key = 0u;
    var digit = 0u;
    if (valid) {
      key = keysIn[index];
      digit = (key >> params.shift) & ${SORT_BINS - 1}u;
      atomicOr(&masks[digit * WORDS + word], bit);
    }
    workgroupBarrier();
    if (valid) {
      var rank = countOneBits(atomicLoad(&masks[digit * WORDS + word]) & (bit - 1u));
      for (var earlier = 0u; earlier < word; earlier++) {
        rank += countOneBits(atomicLoad(&masks[digit * WORDS + earlier]));
      }
      let destination = offsets[digit] + rank;
      keysOut[destination] = key;
      valuesOut[destination] = valuesIn[index];
    }
    workgroupBarrier();
    if (local < ${SORT_BINS}u) {
      var total = 0u;
      for (var w = 0u; w < WORDS; w++) {
        total += countOneBits(atomicLoad(&masks[local * WORDS + w]));
      }
      offsets[local] += total;
    }
    workgroupBarrier();
    if (local < ${SORT_BINS}u * WORDS) {
      atomicStore(&masks[local], 0u);
    }
    workgroupBarrier();
  }
}
`;

// Exclusive prefix sum in one workgroup; each thread sums a contiguous run first. Fast enough for the
// few thousand to few ten thousand entries it gets here.
const SCAN_WGSL = /* wgsl */ `
struct ScanParams {
  length: u32,
  totalIndex: u32,
  unused0: u32,
  unused1: u32,
}

@group(0) @binding(0) var<uniform> params: ScanParams;
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@group(0) @binding(2) var<storage, read_write> totals: array<u32>;

var<workgroup> sums: array<u32, ${WORKGROUP_SIZE}>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(local_invocation_index) local: u32) {
  let run = (params.length + ${WORKGROUP_SIZE - 1}u) / ${WORKGROUP_SIZE}u;
  let start = min(local * run, params.length);
  let end = min(start + run, params.length);
  var sum = 0u;
  for (var i = start; i < end; i++) {
    sum += data[i];
  }
  sums[local] = sum;
  workgroupBarrier();
  for (var offset = 1u; offset < ${WORKGROUP_SIZE}u; offset <<= 1u) {
    var add = 0u;
    if (local >= offset) {
      add = sums[local - offset];
    }
    workgroupBarrier();
    sums[local] += add;
    workgroupBarrier();
  }
  var running = sums[local] - sum;
  for (var i = start; i < end; i++) {
    let value = data[i];
    data[i] = running;
    running += value;
  }
  if (local == ${WORKGROUP_SIZE - 1}u) {
    totals[params.totalIndex] = sums[${WORKGROUP_SIZE - 1}u];
  }
}
`;

function projectWgsl(turbo) {
  const [low, high] = turbo.range;
  const terms = turbo.coefficients.map((k) =>
    `dot(v4, vec4(${k.slice(0, 4).map(Number).join(', ')})) + dot(v2, vec2(${k.slice(4).map(Number).join(', ')}))`);
  return /* wgsl */ `${FRAME_WGSL}${DECODE_WGSL}
@group(0) @binding(1) var<storage, read> splats: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> order: array<u32>;
@group(0) @binding(3) var<storage, read_write> projected: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> colors: array<u32>;
@group(0) @binding(5) var<storage, read_write> blockCounts: array<u32>;

var<workgroup> blockVisible: atomic<u32>;

struct Projection {
  geometry: vec4<u32>,
  visible: bool,
}

fn turbo(t: f32) -> vec3<f32> {
  let x = mix(${low}, ${high}, t);
  let v4 = vec4(1.0, x, x * x, x * x * x);
  let v2 = v4.zw * v4.z;
  return clamp(vec3(${terms.join(', ')}), vec3(0.0), vec3(1.0));
}

// The splat's screen ellipse as a centre in NDC and two half axes of one standard deviation, in the
// eye's foveated image when foveation is on.
fn projectEye(eye: u32, center: vec3<f32>, cov: mat3x3<f32>, extent: f32) -> Projection {
  var result = Projection(vec4<u32>(bitcast<u32>(1.0e4), bitcast<u32>(1.0e4), 0u, 0u), false);
  let modelView = frame.modelView[eye];
  let viewPosition = (modelView * vec4(center, 1.0)).xyz;
  let w = -viewPosition.z;
  if (w < 0.02) {
    return result;
  }
  let projection = frame.projection[eye];
  let clip = projection * vec4(viewPosition, 1.0);
  let ndc = clip.xy / clip.w;
  let fovea = frame.foveation[eye];
  let warpX = warpAxis(ndc.x, fovea.x, fovea.z);
  let warpY = warpAxis(ndc.y, fovea.y, fovea.z);
  let warped = vec2(warpX.x, warpY.x);
  let halfSize = frame.viewport[eye].zw * 0.5 / (1.0 + fovea.z);
  // Jacobian of the projection, taken no further off-centre than 1.3 times the view, as 3DGS does,
  // so splats beside the view do not blow up. The warp scales it locally, so the ellipse and its
  // anti-aliasing come out in the pixels of the image it is drawn into.
  let focal = vec2(projection[0][0], projection[1][1]);
  let slope = (clamp(ndc, vec2(-1.3), vec2(1.3)) + vec2(projection[2][0], projection[2][1])) / focal;
  let jx = vec3(focal.x / w, 0.0, focal.x * slope.x / w) * halfSize.x * warpX.y;
  let jy = vec3(0.0, focal.y / w, focal.y * slope.y / w) * halfSize.y * warpY.y;
  let rotation = mat3x3<f32>(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz);
  let viewCov = rotation * cov * transpose(rotation);
  // Screen covariance in pixels, widened by a little less than half a pixel against aliasing.
  let a = dot(jx, viewCov * jx) + 0.3;
  let b = dot(jx, viewCov * jy);
  let c = dot(jy, viewCov * jy) + 0.3;
  let mid = 0.5 * (a + c);
  let spread = length(vec2(0.5 * (a - c), b));
  let major = mid + spread;
  let minor = max(mid - spread, 0.1);
  var direction = vec2(1.0, 0.0);
  if (abs(b) > 1e-9) {
    direction = normalize(vec2(b, major - a));
  } else if (c > a) {
    direction = vec2(0.0, 1.0);
  }
  let majorRadius = min(sqrt(major), ${MAX_PIXEL_RADIUS}.0 / extent);
  let minorRadius = min(sqrt(minor), majorRadius);
  if (any(abs(warped) > vec2(1.0) + majorRadius * extent / halfSize)) {
    return result;
  }
  let axis1 = direction * majorRadius / halfSize;
  let axis2 = vec2(-direction.y, direction.x) * minorRadius / halfSize;
  result.geometry = vec4<u32>(bitcast<u32>(warped.x), bitcast<u32>(warped.y), pack2x16float(axis1), pack2x16float(axis2));
  result.visible = true;
  return result;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_index) local: u32,
  @builtin(workgroup_id) block: vec3<u32>,
) {
  if (local == 0u) {
    atomicStore(&blockVisible, 0u);
  }
  workgroupBarrier();
  let count = frame.counts.x;
  let slot = id.x;
  if (slot < count) {
    let splat = decodeSplat(splats[order[slot]]);
    let opacity = min(splat.color.a, 1.0);
    var color = 0u;
    if (opacity >= 1.0 / 255.0) {
      // How many standard deviations out the splat still adds at least 1/255.
      let extent = min(3.0, sqrt(2.0 * log(255.0 * opacity)));
      let center = stretched(splat.center);
      let cov = covariance(splat.scales, splat.quaternion);
      var visible = false;
      for (var eye = 0u; eye < frame.counts.y; eye++) {
        let projection = projectEye(eye, center, cov, extent);
        projected[eye * count + slot] = projection.geometry;
        visible = visible || projection.visible;
      }
      if (visible) {
        var rgb = splat.color.rgb;
        if (frame.depth.w > 0.5) {
          // Coloured by the original depth, before the stretch moved the splat.
          let depthSpan = max(frame.depth.y - frame.depth.x, 1e-6);
          rgb = turbo(clamp((frame.depth.y - startDepth(splat.center)) / depthSpan, 0.0, 1.0));
        }
        color = pack4x8unorm(vec4(rgb, opacity));
        atomicAdd(&blockVisible, 1u);
      }
    }
    colors[slot] = color;
  }
  workgroupBarrier();
  if (local == 0u) {
    blockCounts[block.x] = atomicLoad(&blockVisible);
  }
}
`;
}

// Writes the slots of visible splats, still in depth order, to the draw list.
const COMPACT_WGSL = /* wgsl */ `${FRAME_WGSL}
@group(0) @binding(1) var<storage, read> colors: array<u32>;
@group(0) @binding(2) var<storage, read> blockOffsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> drawList: array<u32>;

var<workgroup> prefix: array<u32, ${WORKGROUP_SIZE}>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_index) local: u32,
  @builtin(workgroup_id) block: vec3<u32>,
) {
  let slot = id.x;
  var visible = 0u;
  if (slot < frame.counts.x && (colors[slot] >> 24u) != 0u) {
    visible = 1u;
  }
  prefix[local] = visible;
  workgroupBarrier();
  for (var offset = 1u; offset < ${WORKGROUP_SIZE}u; offset <<= 1u) {
    var add = 0u;
    if (local >= offset) {
      add = prefix[local - offset];
    }
    workgroupBarrier();
    prefix[local] += add;
    workgroupBarrier();
  }
  if (visible == 1u) {
    drawList[blockOffsets[block.x] + prefix[local] - 1u] = slot;
  }
}
`;

const DRAW_WGSL = /* wgsl */ `${FRAME_WGSL}
@group(0) @binding(1) var<storage, read> projected: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> colors: array<u32>;
@group(0) @binding(3) var<storage, read> drawList: array<u32>;
@group(1) @binding(0) var<uniform> eye: vec4<u32>;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  // Position inside the splat in standard deviations.
  @location(0) offset: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let slot = drawList[instance];
  let geometry = projected[eye.x * frame.counts.x + slot];
  let color = unpack4x8unorm(colors[slot]);
  let extent = min(3.0, sqrt(2.0 * log(255.0 * color.a)));
  let corner = vec2(f32(vertex & 1u), f32(vertex >> 1u)) * 2.0 - 1.0;
  let offset = corner * extent;
  let center = vec2(bitcast<f32>(geometry.x), bitcast<f32>(geometry.y));
  var out: Varyings;
  out.position = vec4(center + offset.x * unpack2x16float(geometry.z) + offset.y * unpack2x16float(geometry.w), 0.0, 1.0);
  out.offset = offset;
  out.color = color;
  return out;
}

// Float targets hold linear light; 8-bit targets take the splats' sRGB values as they are.
override linearOutput: bool = false;

@fragment
fn fragmentMain(in: Varyings) -> @location(0) vec4<f32> {
  let alpha = in.color.a * exp(-0.5 * dot(in.offset, in.offset));
  if (alpha < 1.0 / 255.0) {
    discard;
  }
  var rgb = in.color.rgb;
  if (linearOutput) {
    rgb = select(pow((rgb + 0.055) / 1.055, vec3(2.4)), rgb / 12.92, rgb <= vec3(0.04045));
  }
  return vec4(rgb * alpha, alpha);
}
`;

// Spreads an eye's foveated image back out over the eye's viewport.
const UNWARP_WGSL = /* wgsl */ `${FRAME_WGSL}
@group(0) @binding(1) var<uniform> eye: vec4<u32>;
@group(0) @binding(2) var warpedImage: texture_2d<f32>;
@group(0) @binding(3) var warpedSampler: sampler;
@group(0) @binding(4) var glowImage: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
  return vec4(vec2(f32((vertex << 1u) & 2u), f32(vertex & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let viewport = frame.viewport[eye.x];
  let ndc = ((position.xy - viewport.xy) / viewport.zw * 2.0 - 1.0) * vec2(1.0, -1.0);
  let fovea = frame.foveation[eye.x];
  let warped = vec2(warpAxis(ndc.x, fovea.x, fovea.z).x, warpAxis(ndc.y, fovea.y, fovea.z).x);
  let uv = warped * vec2(0.5, -0.5) + 0.5;
  let splats = textureSampleLevel(warpedImage, warpedSampler, uv, 0.0);
  if (frame.counts.w == 0u) {
    return splats;
  }
  // The glow shows wherever the splats leave the view open.
  return splats + (1.0 - splats.a) * textureSampleLevel(glowImage, warpedSampler, uv, 0.0);
}
`;

// The ambilight in VR, made from an eye's warped image. The image is mipmapped with premultiplied
// alpha, so every level holds the average colour of the splats in its cells and how much of each cell
// they cover. The glow walks from the coarsest level to the finest, each covered level replacing the
// coarser ones, and dims further from the scene, as in ambilight.js. Two blur passes then smooth the
// cells of the coarse levels.
const GLOW_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;

// The finest level used is about this wide, and the glow this bright next to the scene.
const FINEST_WIDTH = ${AMBILIGHT_FINEST_WIDTH};
const BRIGHTNESS = ${AMBILIGHT_BRIGHTNESS};

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> Varyings {
  let corner = vec2(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return Varyings(vec4(corner * 2.0 - 1.0, 0.0, 1.0), vec2(corner.x, 1.0 - corner.y));
}

// The next mip level: the average of each 2 × 2 cell of the level above.
@fragment
fn downsampleMain(in: Varyings) -> @location(0) vec4<f32> {
  return textureSampleLevel(source, linearSampler, in.uv, 0.0);
}

@fragment
fn glowMain(in: Varyings) -> @location(0) vec4<f32> {
  let coarsest = f32(textureNumLevels(source) - 1u);
  let finest = min(coarsest, max(0.0, floor(log2(f32(textureDimensions(source).x) / FINEST_WIDTH))));
  let whole = textureSampleLevel(source, linearSampler, in.uv, coarsest);
  if (whole.a <= 0.0) {
    return vec4(0.0);
  }
  var fill = whole.rgb / whole.a;
  // Follows the finest covered level, as a measure of the distance to the scene.
  var near = coarsest;
  for (var level = coarsest - 1.0; level >= finest; level -= 1.0) {
    let cell = textureSampleLevel(source, linearSampler, in.uv, level);
    if (cell.a <= 0.0) {
      continue;
    }
    let weight = clamp(cell.a * 2.5, 0.0, 1.0);
    fill = mix(fill, cell.rgb / cell.a, weight);
    near = mix(near, level, weight);
  }
  let fade = 1.0 - smoothstep(finest, coarsest, near);
  return vec4(fill * BRIGHTNESS * mix(0.4, 1.0, fade), 1.0);
}

// Gaussian blur along one axis, two texels between taps.
fn blur(uv: vec2<f32>, axis: vec2<f32>) -> vec4<f32> {
  var weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let stride = axis * 2.0 / vec2<f32>(textureDimensions(source));
  var sum = textureSampleLevel(source, linearSampler, uv, 0.0) * weights[0];
  for (var i = 1; i < 5; i += 1) {
    let offset = stride * f32(i);
    sum += (textureSampleLevel(source, linearSampler, uv + offset, 0.0) + textureSampleLevel(source, linearSampler, uv - offset, 0.0)) * weights[i];
  }
  return sum;
}

@fragment
fn blurXMain(in: Varyings) -> @location(0) vec4<f32> {
  return blur(in.uv, vec2(1.0, 0.0));
}

@fragment
fn blurYMain(in: Varyings) -> @location(0) vec4<f32> {
  return blur(in.uv, vec2(0.0, 1.0));
}
`;

// The red-cyan view: each eye's image over the page background, mixed with Dubois' matrices in linear
// colour. The eye images hold premultiplied sRGB, as the canvas does.
const ANAGLYPH_WGSL = /* wgsl */ `
@group(0) @binding(0) var leftEye: texture_2d<f32>;
@group(0) @binding(1) var rightEye: texture_2d<f32>;
@group(0) @binding(2) var<uniform> background: vec4<f32>;

const LEFT = mat3x3<f32>(${ANAGLYPH_LEFT.join(', ')});
const RIGHT = mat3x3<f32>(${ANAGLYPH_RIGHT.join(', ')});

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
  let corner = vec2(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn toLinear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, c <= vec3(0.04045));
}

fn toSrgb(c: vec3<f32>) -> vec3<f32> {
  return select(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3(0.0031308));
}

fn opaque(color: vec4<f32>) -> vec3<f32> {
  return toLinear(color.rgb + background.rgb * (1.0 - color.a));
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  let color = LEFT * opaque(textureLoad(leftEye, pixel, 0)) + RIGHT * opaque(textureLoad(rightEye, pixel, 0));
  return vec4(toSrgb(clamp(color, vec3(0.0), vec3(1.0))), 1.0);
}
`;

// xrCompatible: the device will also draw into WebXR sessions, which the adapter must allow from the start.
export async function createComputeSplatRenderer({ turbo, xrCompatible = false }) {
  if (!navigator.gpu) throw new Error('This browser has no WebGPU.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', xrCompatible });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  // GPU timestamps feed the frame-rate displays where the browser offers them.
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return new ComputeSplatRenderer(device, turbo);
}

class ComputeSplatRenderer {
  constructor(device, turbo) {
    this.device = device;
    this.lost = false;
    device.lost.then((info) => {
      this.lost = true;
      console.error('WebGPU device lost:', info.message);
    });
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'splat-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.context = this.canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'premultiplied' });
    this.stats = { scene: null, visible: 0, computeMs: null, drawMs: null, sortsPerSecond: 0 };
    this.lastStatsAt = 0;
    this.statsPending = false;
    this.sorts = 0;
    this.timestamps = device.features.has('timestamp-query');
    this.lastSort = { scene: null, origin: new THREE.Vector3(), stretch: NaN };
    this.capacity = 0;
    this.generation = 0;
    this.frameData = new ArrayBuffer(FRAME_BYTES);
    this.frameFloats = new Float32Array(this.frameData);
    this.frameUints = new Uint32Array(this.frameData);
    this.modelView = new THREE.Matrix4();
    this.modelInverse = new THREE.Matrix4();
    this.origin = new THREE.Vector3();

    const usage = GPUBufferUsage;
    this.frameBuffer = device.createBuffer({ size: FRAME_BYTES, usage: usage.UNIFORM | usage.COPY_DST });
    this.sortParams = Array.from({ length: SORT_PASSES }, () =>
      device.createBuffer({ size: 16, usage: usage.UNIFORM | usage.COPY_DST }));
    this.histogramScanParams = device.createBuffer({ size: 16, usage: usage.UNIFORM | usage.COPY_DST });
    this.blockScanParams = device.createBuffer({ size: 16, usage: usage.UNIFORM | usage.COPY_DST });
    this.scratch = device.createBuffer({ size: 16, usage: usage.STORAGE });
    this.indirect = device.createBuffer({ size: 16, usage: usage.INDIRECT | usage.STORAGE | usage.COPY_SRC | usage.COPY_DST });
    device.queue.writeBuffer(this.indirect, 0, new Uint32Array([4, 0, 0, 0]));
    // Visible count at byte 0, then four GPU timestamps from byte 8: compute start and end, draw start and end.
    this.statsBuffer = device.createBuffer({ size: 40, usage: usage.MAP_READ | usage.COPY_DST });
    if (this.timestamps) {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
      this.queryResolve = device.createBuffer({ size: 32, usage: usage.QUERY_RESOLVE | usage.COPY_SRC });
    }
    this.eyeBuffers = [0, 1].map((eye) => {
      const buffer = device.createBuffer({ size: 16, usage: usage.UNIFORM | usage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Uint32Array([eye, 0, 0, 0]));
      return buffer;
    });

    const compute = (code) => device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    this.keysPipeline = compute(KEYS_WGSL);
    this.countPipeline = compute(SORT_COUNT_WGSL);
    this.scatterPipeline = compute(SORT_SCATTER_WGSL);
    this.scanPipeline = compute(SCAN_WGSL);
    this.projectPipeline = compute(projectWgsl(turbo));
    this.compactPipeline = compute(COMPACT_WGSL);
    // Explicit layouts, so the draw pipelines for the canvas and for a headset's format share bind groups.
    const vertexBuffer = (type) => ({ visibility: GPUShaderStage.VERTEX, buffer: { type } });
    this.drawGroupLayout = device.createBindGroupLayout({
      entries: ['uniform', 'read-only-storage', 'read-only-storage', 'read-only-storage'].map((type, binding) => ({ binding, ...vertexBuffer(type) })),
    });
    const eyeGroupLayout = device.createBindGroupLayout({ entries: [{ binding: 0, ...vertexBuffer('uniform') }] });
    this.drawLayout = device.createPipelineLayout({ bindGroupLayouts: [this.drawGroupLayout, eyeGroupLayout] });
    this.drawModule = device.createShaderModule({ code: DRAW_WGSL });
    this.drawPipelines = new Map();
    this.eyeBindGroups = this.eyeBuffers.map((buffer) => device.createBindGroup({
      layout: eyeGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    }));
    const fragment = GPUShaderStage.FRAGMENT;
    this.unwarpGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragment, buffer: { type: 'uniform' } },
        { binding: 1, visibility: fragment, buffer: { type: 'uniform' } },
        { binding: 2, visibility: fragment, texture: {} },
        { binding: 3, visibility: fragment, sampler: {} },
        { binding: 4, visibility: fragment, texture: {} },
      ],
    });
    this.unwarpModule = device.createShaderModule({ code: UNWARP_WGSL });
    this.unwarpPipelines = new Map();
    this.warpSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.warpedImages = [null, null];
    this.glowGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragment, texture: {} },
        { binding: 1, visibility: fragment, sampler: {} },
      ],
    });
    this.glowModule = device.createShaderModule({ code: GLOW_WGSL });
    this.glowPipelines = new Map();
    this.anaglyph = null;
  }

  upload(packedSplats) {
    const count = packedSplats.numSplats;
    const buffer = this.device.createBuffer({
      size: Math.max(16, count * 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    if (count) this.device.queue.writeBuffer(buffer, 0, packedSplats.packedArray, 0, count * 4);
    return { buffer, count, encoding: { ...DEFAULT_ENCODING, ...packedSplats.splatEncoding }, bindGroups: null };
  }

  release(scene) {
    scene.buffer.destroy();
    if (this.stats.scene === scene) this.stats.scene = null;
    if (this.lastSort.scene === scene) this.lastSort.scene = null;
  }

  ensureCapacity(count) {
    if (count <= this.capacity) return;
    for (const buffer of this.sized ?? []) buffer.destroy();
    const device = this.device;
    const capacity = Math.ceil(count * 1.25);
    const storage = (bytes) => device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE });
    this.keys = [storage(capacity * 4), storage(capacity * 4)];
    this.values = [storage(capacity * 4), storage(capacity * 4)];
    this.histogram = storage(SORT_BINS * Math.ceil(capacity / SORT_BLOCK) * 4);
    this.projected = storage(2 * capacity * 16);
    this.colors = storage(capacity * 4);
    this.blockCounts = storage(Math.ceil(capacity / WORKGROUP_SIZE) * 4);
    this.drawList = storage(capacity * 4);
    this.sized = [...this.keys, ...this.values, this.histogram, this.projected, this.colors, this.blockCounts, this.drawList];
    this.capacity = capacity;
    this.generation += 1;
    const group = (pipeline, buffers) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    // The sort ping-pongs between the two key and value buffers and ends where it began.
    this.sortGroups = Array.from({ length: SORT_PASSES }, (_, pass) => {
      const from = pass % 2;
      const to = 1 - from;
      return {
        count: group(this.countPipeline, [this.sortParams[pass], this.keys[from], this.histogram]),
        scan: group(this.scanPipeline, [this.histogramScanParams, this.histogram, this.scratch]),
        scatter: group(this.scatterPipeline, [this.sortParams[pass], this.keys[from], this.values[from], this.keys[to], this.values[to], this.histogram]),
      };
    });
    this.blockScanGroup = group(this.scanPipeline, [this.blockScanParams, this.blockCounts, this.indirect]);
    this.compactGroup = group(this.compactPipeline, [this.frameBuffer, this.colors, this.blockCounts, this.drawList]);
    this.drawGroup = device.createBindGroup({
      layout: this.drawGroupLayout,
      entries: [this.frameBuffer, this.projected, this.colors, this.drawList].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.group = group;
  }

  sceneGroups(scene) {
    if (scene.bindGroups?.generation !== this.generation) {
      scene.bindGroups = {
        generation: this.generation,
        keys: this.group(this.keysPipeline, [this.frameBuffer, scene.buffer, this.keys[0], this.values[0]]),
        project: this.group(this.projectPipeline, [this.frameBuffer, scene.buffer, this.values[0], this.projected, this.colors, this.blockCounts]),
      };
    }
    return scene.bindGroups;
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  drawPipeline(format) {
    if (!this.drawPipelines.has(format)) {
      const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      this.drawPipelines.set(format, this.device.createRenderPipeline({
        layout: this.drawLayout,
        vertex: { module: this.drawModule, entryPoint: 'vertexMain' },
        fragment: {
          module: this.drawModule,
          entryPoint: 'fragmentMain',
          constants: { linearOutput: format === 'rgba16float' ? 1 : 0 },
          targets: [{ format, blend: { color: blend, alpha: blend } }],
        },
        primitive: { topology: 'triangle-strip' },
      }));
    }
    return this.drawPipelines.get(format);
  }

  unwarpPipeline(format) {
    if (!this.unwarpPipelines.has(format)) {
      this.unwarpPipelines.set(format, this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.unwarpGroupLayout] }),
        vertex: { module: this.unwarpModule, entryPoint: 'vertexMain' },
        fragment: { module: this.unwarpModule, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }));
    }
    return this.unwarpPipelines.get(format);
  }

  // A pipeline of the ambilight's shader drawing into the given format; entry: downsample, glow, blurX, blurY.
  glowPipeline(entry, format) {
    const key = `${entry}|${format}`;
    if (!this.glowPipelines.has(key)) {
      this.glowPipelines.set(key, this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.glowGroupLayout] }),
        vertex: { module: this.glowModule, entryPoint: 'vertexMain' },
        fragment: { module: this.glowModule, entryPoint: `${entry}Main`, targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      }));
    }
    return this.glowPipelines.get(key);
  }

  glowGroup(view) {
    return this.device.createBindGroup({
      layout: this.glowGroupLayout,
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.warpSampler }],
    });
  }

  // The smaller image an eye's splats go into when foveated, 1 + strength times smaller than the eye's.
  // It carries mip levels and two glow images for the ambilight.
  warpedImage(eye, format, [, , width, height], strength) {
    const size = [Math.max(1, Math.round(width / (1 + strength))), Math.max(1, Math.round(height / (1 + strength)))];
    const key = `${size.join('x')}|${format}`;
    let image = this.warpedImages[eye];
    if (image?.key !== key) {
      if (image) for (const texture of [image.texture, ...image.glows.map((glow) => glow.texture)]) texture.destroy();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const mipLevelCount = Math.floor(Math.log2(Math.max(...size))) + 1;
      const texture = this.device.createTexture({ size, format, mipLevelCount, usage });
      const levels = Array.from({ length: mipLevelCount }, (_, level) => texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
      const glowSize = size.map((length) => Math.max(1, Math.round(length * GLOW_SCALE)));
      const glows = [0, 1].map(() => {
        const glow = this.device.createTexture({ size: glowSize, format: GLOW_FORMAT, usage });
        const view = glow.createView();
        return { texture: glow, view, group: this.glowGroup(view) };
      });
      image = {
        key,
        texture,
        view: levels[0],
        // Each level after the first, with the level above it to draw from.
        mips: levels.slice(1).map((view, index) => ({ view, group: this.glowGroup(levels[index]) })),
        mipGroup: this.glowGroup(texture.createView()),
        glows,
        group: this.device.createBindGroup({
          layout: this.unwarpGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.frameBuffer } },
            { binding: 1, resource: { buffer: this.eyeBuffers[eye] } },
            { binding: 2, resource: levels[0] },
            { binding: 3, resource: this.warpSampler },
            { binding: 4, resource: glows[0].view },
          ],
        }),
      };
      this.warpedImages[eye] = image;
    }
    return image;
  }

  // Mipmaps an eye's warped image, makes the glow from its levels and blurs it, ending in glows[0].
  encodeGlow(encoder, image, format) {
    const draw = (view, pipeline, group) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    };
    for (const mip of image.mips) draw(mip.view, this.glowPipeline('downsample', format), mip.group);
    const [glow, blurred] = image.glows;
    draw(glow.view, this.glowPipeline('glow', GLOW_FORMAT), image.mipGroup);
    draw(blurred.view, this.glowPipeline('blurX', GLOW_FORMAT), glow.group);
    draw(glow.view, this.glowPipeline('blurY', GLOW_FORMAT), blurred.group);
  }

  // viewports: per eye [x, y, width, height] in pixels of the target, from the top left.
  // foveation: strength of the warp in VR, 0 for none.
  writeFrame(scene, { model, views, origin, startView, depthRange, stretch, depthColors, foveation = 0, ambilight = false }, viewports) {
    const floats = this.frameFloats;
    const uints = this.frameUints;
    floats.fill(0);
    views.forEach(({ view, projection }, eye) => {
      floats.set(this.modelView.multiplyMatrices(view, model).elements, eye * 16);
      floats.set(projection.elements, 32 + eye * 16);
      floats.set(viewports[eye], 64 + eye * 4);
      // The lens centre is where the eye's straight-ahead direction lands in its asymmetric frustum.
      const p = projection.elements;
      floats.set([THREE.MathUtils.clamp(-p[8], -0.5, 0.5), THREE.MathUtils.clamp(-p[9], -0.5, 0.5), foveation, 0], 92 + eye * 4);
    });
    floats.set(this.origin.copy(origin).applyMatrix4(this.modelInverse.copy(model).invert()).toArray(), 72);
    if (startView) {
      const e = startView.elements;
      floats.set([-e[2], -e[6], -e[10], -e[14]], 76);
    }
    floats.set([depthRange?.[0] ?? 0, depthRange?.[1] ?? 1, startView ? stretch : 0, depthColors && startView ? 1 : 0], 80);
    const { rgbMin, rgbMax, lnScaleMin, lnScaleMax, lodOpacity } = scene.encoding;
    floats.set([rgbMin, rgbMax, lnScaleMin, lnScaleMax], 84);
    uints.set([scene.count, views.length, lodOpacity ? 1 : 0, ambilight && foveation > 0 ? 1 : 0], 88);
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
  }

  needsSort(scene, origin, stretch) {
    const last = this.lastSort;
    if (last.scene === scene && Math.abs(last.stretch - stretch) < RESORT_STRETCH
      && last.origin.distanceTo(origin) < RESORT_DISTANCE) return false;
    last.scene = scene;
    last.stretch = stretch;
    last.origin.copy(origin);
    this.sorts += 1;
    return true;
  }

  timestampWrites(begin, end) {
    // A pass in the middle writes no timestamp, and WebGPU rejects timestampWrites without an index.
    if (!this.timestamps || (begin === undefined && end === undefined)) return {};
    const writes = { querySet: this.querySet };
    if (begin !== undefined) writes.beginningOfPassWriteIndex = begin;
    if (end !== undefined) writes.endOfPassWriteIndex = end;
    return { timestampWrites: writes };
  }

  // Sorting when needed, projection, culling and compaction into the draw list.
  encodeCompute(encoder, scene, options, viewports) {
    const count = scene.count;
    this.ensureCapacity(count);
    this.writeFrame(scene, options, viewports);
    const groups = this.sceneGroups(scene);
    const blocks = Math.ceil(count / WORKGROUP_SIZE);
    const sortBlocks = Math.ceil(count / SORT_BLOCK);
    const queue = this.device.queue;
    const pass = encoder.beginComputePass(this.timestampWrites(0, 1));
    if (count && this.needsSort(scene, options.origin, options.stretch)) {
      for (let p = 0; p < SORT_PASSES; p += 1) queue.writeBuffer(this.sortParams[p], 0, new Uint32Array([p * SORT_BITS, count, sortBlocks, 0]));
      queue.writeBuffer(this.histogramScanParams, 0, new Uint32Array([SORT_BINS * sortBlocks, 0, 0, 0]));
      pass.setPipeline(this.keysPipeline);
      pass.setBindGroup(0, groups.keys);
      pass.dispatchWorkgroups(blocks);
      for (const sortGroup of this.sortGroups) {
        pass.setPipeline(this.countPipeline);
        pass.setBindGroup(0, sortGroup.count);
        pass.dispatchWorkgroups(sortBlocks);
        pass.setPipeline(this.scanPipeline);
        pass.setBindGroup(0, sortGroup.scan);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(this.scatterPipeline);
        pass.setBindGroup(0, sortGroup.scatter);
        pass.dispatchWorkgroups(sortBlocks);
      }
    }
    queue.writeBuffer(this.blockScanParams, 0, new Uint32Array([blocks, 1, 0, 0]));
    if (count) {
      pass.setPipeline(this.projectPipeline);
      pass.setBindGroup(0, groups.project);
      pass.dispatchWorkgroups(blocks);
    }
    pass.setPipeline(this.scanPipeline);
    pass.setBindGroup(0, this.blockScanGroup);
    pass.dispatchWorkgroups(1);
    if (count) {
      pass.setPipeline(this.compactPipeline);
      pass.setBindGroup(0, this.compactGroup);
      pass.dispatchWorkgroups(blocks);
    }
    pass.end();
  }

  drawSplats(pass, format, eye) {
    pass.setPipeline(this.drawPipeline(format));
    pass.setBindGroup(0, this.drawGroup);
    pass.setBindGroup(1, this.eyeBindGroups[eye]);
    pass.drawIndirect(this.indirect, 0);
  }

  // targets: [{ view: GPUTextureView, format, eyes: [eye indices drawn into it] }]. Each is cleared
  // first. overlay.before(encoder, eye) runs before a target's pass, overlay.after(pass, eye) draws on
  // top of an eye's splats. With foveation the splats first go into each eye's warped image, which the
  // target's pass then spreads out, over the ambilight's glow when ambilight is on.
  encodeDraw(encoder, scene, targets, viewports, overlay, foveation = 0, ambilight = false) {
    const clear = { loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' };
    const warped = !!scene && foveation > 0;
    let first = true;
    // The draw time runs from the first of these passes to the end of the last target's.
    const beginPass = (view, last) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, ...clear }],
        ...this.timestampWrites(first ? 2 : undefined, last ? 3 : undefined),
      });
      first = false;
      return pass;
    };
    targets.forEach((target, index) => {
      for (const eye of target.eyes) overlay?.before?.(encoder, eye);
      if (warped) {
        for (const eye of target.eyes) {
          const image = this.warpedImage(eye, target.format, viewports[eye], foveation);
          const pass = beginPass(image.view, false);
          this.drawSplats(pass, target.format, eye);
          pass.end();
          if (ambilight) this.encodeGlow(encoder, image, target.format);
        }
      }
      const pass = beginPass(target.view, index === targets.length - 1);
      for (const eye of target.eyes) {
        const [x, y, w, h] = viewports[eye];
        pass.setViewport(x, y, w, h, 0, 1);
        if (warped) {
          pass.setPipeline(this.unwarpPipeline(target.format));
          pass.setBindGroup(0, this.warpedImages[eye].group);
          pass.draw(3);
        } else if (scene) {
          this.drawSplats(pass, target.format, eye);
        }
        overlay?.after?.(pass, eye);
      }
      pass.end();
    });
  }

  submit(encoder, scene) {
    const readStats = scene && !this.statsPending && performance.now() - this.lastStatsAt > STATS_INTERVAL_MS;
    if (readStats) {
      encoder.copyBufferToBuffer(this.indirect, 4, this.statsBuffer, 0, 4);
      if (this.timestamps) {
        encoder.resolveQuerySet(this.querySet, 0, 4, this.queryResolve, 0);
        encoder.copyBufferToBuffer(this.queryResolve, 0, this.statsBuffer, 8, 32);
      }
    }
    this.device.queue.submit([encoder.finish()]);
    if (!readStats) return;
    this.statsPending = true;
    this.statsBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const range = this.statsBuffer.getMappedRange();
      const elapsed = (performance.now() - this.lastStatsAt) / 1000;
      this.stats.visible = new Uint32Array(range, 0, 1)[0];
      this.stats.scene = scene;
      this.stats.sortsPerSecond = this.lastStatsAt ? this.sorts / elapsed : 0;
      this.sorts = 0;
      if (this.timestamps) {
        const [computeStart, computeEnd, drawStart, drawEnd] = new BigInt64Array(range, 8, 4);
        const ms = (start, end) => (end > start ? Number(end - start) / 1e6 : null);
        this.stats.computeMs = ms(computeStart, computeEnd);
        this.stats.drawMs = ms(drawStart, drawEnd);
      }
      this.statsBuffer.unmap();
    }).catch(() => {}).finally(() => {
      this.statsPending = false;
      this.lastStatsAt = performance.now();
    });
  }

  // The flat view: renders into the page's splat canvas.
  // views: [{ view, projection, viewport }] with three.js matrices and viewports in drawing-buffer pixels.
  render(scene, options) {
    const { width, height, scale = 1 } = options;
    this.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    // three.js viewports count from the bottom left, WebGPU's from the top left. Rounded to whole
    // pixels inside the canvas; scaling can leave fractions that overshoot it.
    const viewports = options.views.map(({ viewport: v }) => {
      const left = Math.min(Math.max(0, Math.round(v.x * scale)), this.canvas.width - 1);
      const top = Math.min(Math.max(0, Math.round((height - v.y - v.w) * scale)), this.canvas.height - 1);
      return [left, top, Math.max(1, Math.min(Math.round(v.z * scale), this.canvas.width - left)), Math.max(1, Math.min(Math.round(v.w * scale), this.canvas.height - top))];
    });
    const encoder = this.device.createCommandEncoder();
    this.encodeCompute(encoder, scene, options, viewports);
    this.encodeDraw(encoder, scene, [{
      view: this.context.getCurrentTexture().createView(),
      format: this.format,
      eyes: options.views.map((_, eye) => eye),
    }], viewports);
    this.submit(encoder, scene);
  }

  // The eye images of the red-cyan view, at the canvas's size, and what mixes them into it.
  anaglyphImages() {
    const size = [this.canvas.width, this.canvas.height];
    const key = size.join('x');
    if (this.anaglyph?.key === key) return this.anaglyph;
    for (const image of this.anaglyph?.images ?? []) image.texture.destroy();
    const device = this.device;
    let pipeline = this.anaglyph?.pipeline;
    if (!pipeline) {
      const module = device.createShaderModule({ code: ANAGLYPH_WGSL });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      });
    }
    const params = this.anaglyph?.params ?? device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const images = [0, 1].map(() => {
      const texture = device.createTexture({ size, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      return { texture, view: texture.createView() };
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: images[0].view },
        { binding: 1, resource: images[1].view },
        { binding: 2, resource: { buffer: params } },
      ],
    });
    this.anaglyph = { key, pipeline, params, images, group };
    return this.anaglyph;
  }

  // The flat red-cyan view: options as for render(), with the two eyes' views and background, the
  // page's colour as sRGB [r, g, b] from 0 to 1. Each eye fills the whole canvas.
  renderAnaglyph(scene, options) {
    this.resize(Math.max(1, Math.round(options.width)), Math.max(1, Math.round(options.height)));
    const anaglyph = this.anaglyphImages();
    const viewports = options.views.map(() => [0, 0, this.canvas.width, this.canvas.height]);
    this.device.queue.writeBuffer(anaglyph.params, 0, new Float32Array([...options.background, 1]));
    const encoder = this.device.createCommandEncoder();
    this.encodeCompute(encoder, scene, options, viewports);
    this.encodeDraw(encoder, scene, anaglyph.images.map((image, eye) => ({ view: image.view, format: this.format, eyes: [eye] })), viewports);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }],
    });
    pass.setPipeline(anaglyph.pipeline);
    pass.setBindGroup(0, anaglyph.group);
    pass.draw(3);
    pass.end();
    this.submit(encoder, scene);
  }

  // A headset's own textures, one target per eye. scene may be null to draw only the overlay.
  renderTargets(scene, options, targets, viewports, overlay) {
    const encoder = this.device.createCommandEncoder();
    if (scene) this.encodeCompute(encoder, scene, options, viewports);
    this.encodeDraw(encoder, scene, targets, viewports, overlay, scene ? options.foveation : 0, !!scene && !!options.ambilight);
    this.submit(encoder, scene);
  }
}

// Stands in for Spark's SplatMesh in the scene graph: carries the transform, the CPU-side splats for
// measuring, and the GPU copy the compute renderer draws.
export class ComputeSplats extends THREE.Object3D {
  constructor(renderer, packedSplats) {
    super();
    this.isComputeSplats = true;
    this.renderer = renderer;
    this.packedSplats = packedSplats;
    this.gpu = renderer.upload(packedSplats);
  }

  get numSplats() {
    return this.renderer.stats.scene === this.gpu ? this.renderer.stats.visible : this.packedSplats.numSplats;
  }

  updateVersion() {}

  dispose() {
    this.renderer.release(this.gpu);
    this.packedSplats.dispose();
  }
}
