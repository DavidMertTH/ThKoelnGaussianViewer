import * as THREE from 'three';

// VR on WebGPU: the compute renderer draws the splats straight into the headset's own image through
// XRGPUBinding, with no hand-over to WebGL. Quest Browser offers this behind "WebXR experimental
// features" in chrome://flags (version 146 and later).
//
// The VR interface keeps its three.js objects. This module drives them the way three.js would:
// controllers are groups that get their poses and 'connected', 'selectstart' and 'selectend' events
// from the session, and a small WebGPU renderer draws the meshes of the interface (browser panel,
// loading card, rays, cursor, highlight, controller shapes, the FPS readout) on top of the splats.

export const webGpuXrSupported = () => typeof globalThis.XRGPUBinding !== 'undefined';

const MAX_EYES = 2;
const DRAW_BYTES = 96;
// Interface meshes are drawn with this many samples per pixel, so their edges are smooth; the splats
// are not, which keeps their cost unchanged.
const OVERLAY_SAMPLES = 4;
// Warp strength at full foveation. The splats then render into an image two thirds the eye's size
// along each axis, under half the pixels: full resolution at the lens centre, about 85 % some 20°
// out, 70 % at 30° and a fifth at the very edge.
const FOVEATION_STRENGTH = 0.5;

const OVERLAY_WGSL = /* wgsl */ `
struct Draw {
  model: mat4x4<f32>,
  // Premultiplied colour, or (opacity, opacity, opacity, opacity) for textured meshes.
  color: vec4<f32>,
  // x: 1 lights the mesh from above, so solid shapes read as shapes.
  params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> viewProjection: mat4x4<f32>;
@group(1) @binding(0) var<storage, read> draws: array<Draw>;
@group(2) @binding(0) var map: texture_2d<f32>;
@group(2) @binding(1) var mapSampler: sampler;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) @interpolate(flat) index: u32,
}

@vertex
fn vertexMain(
  @location(0) position: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) normal: vec3<f32>,
  @builtin(instance_index) index: u32,
) -> Varyings {
  let model = draws[index].model;
  var out: Varyings;
  out.position = viewProjection * model * vec4(position, 1.0);
  out.uv = uv;
  out.normal = (model * vec4(normal, 0.0)).xyz;
  out.index = index;
  return out;
}

override linearOutput: bool = false;

fn output(color: vec4<f32>) -> vec4<f32> {
  if (!linearOutput || color.a <= 0.0) {
    return color;
  }
  let rgb = color.rgb / color.a;
  return vec4(select(pow((rgb + 0.055) / 1.055, vec3(2.4)), rgb / 12.92, rgb <= vec3(0.04045)) * color.a, color.a);
}

@fragment
fn colorMain(in: Varyings) -> @location(0) vec4<f32> {
  let draw = draws[in.index];
  var color = draw.color;
  if (draw.params.x > 0.5) {
    let normal = normalize(in.normal);
    let light = 0.35 + 0.55 * max(dot(normal, normalize(vec3(0.3, 1.0, 0.6))), 0.0) + 0.25 * pow(max(normal.y, 0.0), 8.0);
    color = vec4(color.rgb * light, color.a);
  }
  return output(color);
}

@fragment
fn textureMain(in: Varyings) -> @location(0) vec4<f32> {
  return output(textureSample(map, mapSampler, vec2(in.uv.x, 1.0 - in.uv.y)) * draws[in.index].color.a);
}

// Clears colour and alpha, so a quad layer behind the projection layer shows through.
@fragment
fn punchMain() -> @location(0) vec4<f32> {
  return vec4(0.0);
}
`;

// Lays the anti-aliased interface image over the splats.
const COMPOSITE_WGSL = /* wgsl */ `
@group(0) @binding(0) var overlay: texture_2d<f32>;
@group(0) @binding(1) var overlaySampler: sampler;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> Varyings {
  let corner = vec2(f32((vertex << 1u) & 2u), f32(vertex & 2u)) * 2.0 - 1.0;
  var out: Varyings;
  out.position = vec4(corner, 0.0, 1.0);
  out.uv = vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: Varyings) -> @location(0) vec4<f32> {
  return textureSample(overlay, overlaySampler, in.uv);
}
`;

// Halves a texture level into the next one, for the mipmaps of the interface's canvas textures.
const MIPMAP_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> Varyings {
  let corner = vec2(f32((vertex << 1u) & 2u), f32(vertex & 2u)) * 2.0 - 1.0;
  var out: Varyings;
  out.position = vec4(corner, 0.0, 1.0);
  out.uv = vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: Varyings) -> @location(0) vec4<f32> {
  return textureSample(source, sourceSampler, in.uv);
}
`;

const CULL_MODES = { [THREE.FrontSide]: 'back', [THREE.BackSide]: 'front', [THREE.DoubleSide]: 'none' };

// Draws the visible MeshBasicMaterial meshes of a three.js scene in render order: plain colours,
// optionally lit, canvas textures, and hole-punch materials that write zero. The meshes are drawn
// multisampled with depth into a separate image per eye, which is then laid over the splats; the
// hole punches go straight into the eye's image beforehand.
class OverlayRenderer {
  constructor(device, format) {
    this.device = device;
    this.format = format;
    this.items = [];
    this.geometries = new WeakMap();
    this.textures = new WeakMap();
    this.pipelines = new Map();
    this.color = new THREE.Color();
    const stage = GPUShaderStage;
    this.eyeLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: stage.VERTEX, buffer: { type: 'uniform' } }] });
    this.drawLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: stage.VERTEX | stage.FRAGMENT, buffer: { type: 'read-only-storage' } }],
    });
    this.textureLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: stage.FRAGMENT, texture: {} },
        { binding: 1, visibility: stage.FRAGMENT, sampler: {} },
      ],
    });
    this.module = device.createShaderModule({ code: OVERLAY_WGSL });
    const compositeModule = device.createShaderModule({ code: COMPOSITE_WGSL });
    this.compositeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: stage.FRAGMENT, texture: {} },
        { binding: 1, visibility: stage.FRAGMENT, sampler: {} },
      ],
    });
    const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
    this.compositePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vertexMain' },
      fragment: { module: compositeModule, entryPoint: 'fragmentMain', targets: [{ format, blend: { color: over, alpha: over } }] },
      primitive: { topology: 'triangle-list' },
    });
    this.eyeBuffers = Array.from({ length: MAX_EYES }, () =>
      device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.eyeGroups = this.eyeBuffers.map((buffer) => device.createBindGroup({ layout: this.eyeLayout, entries: [{ binding: 0, resource: { buffer } }] }));
    // Text on the panel and the loading card is shown smaller than its canvas: sampling between mipmap
    // levels, and along the slant when seen at an angle, keeps it smooth instead of jagged.
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8 });
    this.mipmapSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const mipmapModule = device.createShaderModule({ code: MIPMAP_WGSL });
    this.mipmapPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mipmapModule, entryPoint: 'vertexMain' },
      fragment: { module: mipmapModule, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.capacity = 0;
    this.ensureCapacity(64);
  }

  // kind: 'color', 'texture' or 'punch'. The multisampled pass has depth; the punch pass has neither.
  pipeline(kind, { depthTest = false, depthWrite = false, cull = 'none' } = {}) {
    const multisampled = kind !== 'punch';
    const key = `${kind}|${depthTest}|${depthWrite}|${cull}`;
    if (!this.pipelines.has(key)) {
      const blend = kind === 'punch'
        ? { srcFactor: 'zero', dstFactor: 'zero', operation: 'add' }
        : { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      const groups = kind === 'texture' ? [this.eyeLayout, this.drawLayout, this.textureLayout] : [this.eyeLayout, this.drawLayout];
      this.pipelines.set(key, this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: groups }),
        vertex: {
          module: this.module,
          entryPoint: 'vertexMain',
          buffers: [{
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x2' },
              { shaderLocation: 2, offset: 20, format: 'float32x3' },
            ],
          }],
        },
        fragment: {
          module: this.module,
          entryPoint: `${kind}Main`,
          constants: { linearOutput: this.format === 'rgba16float' ? 1 : 0 },
          targets: [{ format: this.format, blend: { color: blend, alpha: blend } }],
        },
        primitive: { topology: 'triangle-list', cullMode: cull },
        ...(multisampled ? {
          multisample: { count: OVERLAY_SAMPLES },
          depthStencil: { format: 'depth24plus', depthWriteEnabled: depthWrite, depthCompare: depthTest ? 'less' : 'always' },
        } : {}),
      }));
    }
    return this.pipelines.get(key);
  }

  ensureCapacity(count) {
    if (count <= this.capacity) return;
    this.drawBuffer?.destroy();
    this.capacity = Math.max(count, this.capacity * 2);
    this.drawBuffer = this.device.createBuffer({ size: this.capacity * DRAW_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.drawGroup = this.device.createBindGroup({ layout: this.drawLayout, entries: [{ binding: 0, resource: { buffer: this.drawBuffer } }] });
    this.drawData = new Float32Array(this.capacity * DRAW_BYTES / 4);
  }

  // One set of targets of the eye's size, shared by both eyes: they are drawn one after the other.
  ensureTargets(width, height) {
    if (this.targetSize === `${width}x${height}`) return;
    for (const texture of [this.multisampled, this.depth, this.resolved]) texture?.destroy();
    const attachment = GPUTextureUsage.RENDER_ATTACHMENT;
    this.multisampled = this.device.createTexture({ size: [width, height], format: this.format, sampleCount: OVERLAY_SAMPLES, usage: attachment });
    this.depth = this.device.createTexture({ size: [width, height], format: 'depth24plus', sampleCount: OVERLAY_SAMPLES, usage: attachment });
    this.resolved = this.device.createTexture({ size: [width, height], format: this.format, usage: attachment | GPUTextureUsage.TEXTURE_BINDING });
    this.compositeGroup = this.device.createBindGroup({
      layout: this.compositeLayout,
      entries: [{ binding: 0, resource: this.resolved.createView() }, { binding: 1, resource: this.sampler }],
    });
    this.targetSize = `${width}x${height}`;
  }

  // Positions, UVs and normals, unindexed, cached per geometry.
  geometry(geometry) {
    let entry = this.geometries.get(geometry);
    if (entry) return entry;
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i += 1) {
      const vertex = index ? index.getX(i) : i;
      data.set([
        position.getX(vertex), position.getY(vertex), position.getZ(vertex),
        uv ? uv.getX(vertex) : 0, uv ? uv.getY(vertex) : 0,
        normal ? normal.getX(vertex) : 0, normal ? normal.getY(vertex) : 0, normal ? normal.getZ(vertex) : 1,
      ], i * 8);
    }
    const buffer = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, data);
    entry = { buffer, count };
    this.geometries.set(geometry, entry);
    return entry;
  }

  // Canvas textures are copied to the GPU again whenever three.js marks them as changed.
  texture(texture) {
    const image = texture.image;
    let entry = this.textures.get(texture);
    if (!entry || entry.width !== image.width || entry.height !== image.height) {
      entry?.gpu.destroy();
      const gpu = this.device.createTexture({
        size: [image.width, image.height],
        format: 'rgba8unorm',
        mipLevelCount: Math.floor(Math.log2(Math.max(image.width, image.height))) + 1,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      entry = {
        gpu,
        width: image.width,
        height: image.height,
        version: -1,
        group: this.device.createBindGroup({
          layout: this.textureLayout,
          entries: [{ binding: 0, resource: gpu.createView() }, { binding: 1, resource: this.sampler }],
        }),
      };
      this.textures.set(texture, entry);
    }
    if (entry.version !== texture.version) {
      this.device.queue.copyExternalImageToTexture({ source: image }, { texture: entry.gpu, premultipliedAlpha: true }, [image.width, image.height]);
      this.generateMipmaps(entry.gpu);
      entry.version = texture.version;
    }
    return entry;
  }

  generateMipmaps(texture) {
    const encoder = this.device.createCommandEncoder();
    for (let level = 1; level < texture.mipLevelCount; level += 1) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.mipmapPipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.mipmapPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.mipmapSampler },
        ],
      }));
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  prepare(scene, viewProjections) {
    const meshes = [];
    scene.traverseVisible((object) => {
      if (object.isMesh && object.material?.isMeshBasicMaterial && object.material.visible) meshes.push(object);
    });
    meshes.sort((a, b) => a.renderOrder - b.renderOrder);
    this.ensureCapacity(meshes.length);
    this.items = meshes.map((mesh, index) => {
      const { material } = mesh;
      const punch = material.blending === THREE.CustomBlending && material.blendSrc === THREE.ZeroFactor;
      const opacity = material.transparent ? material.opacity : 1;
      const offset = index * (DRAW_BYTES / 4);
      this.drawData.set(mesh.matrixWorld.elements, offset);
      if (material.map) {
        this.drawData.set([opacity, opacity, opacity, opacity], offset + 16);
      } else {
        material.color.getRGB(this.color, THREE.SRGBColorSpace);
        this.drawData.set([this.color.r * opacity, this.color.g * opacity, this.color.b * opacity, opacity], offset + 16);
      }
      this.drawData.set([mesh.userData.shaded ? 1 : 0, 0, 0, 0], offset + 20);
      const kind = punch ? 'punch' : material.map ? 'texture' : 'color';
      return {
        kind,
        pipeline: this.pipeline(kind, { depthTest: material.depthTest, depthWrite: material.depthWrite, cull: CULL_MODES[material.side] }),
        punch,
        geometry: this.geometry(mesh.geometry),
        texture: kind === 'texture' && material.map?.image ? this.texture(material.map) : null,
        index,
      };
    }).filter((item) => item.kind !== 'texture' || item.texture);
    if (meshes.length) this.device.queue.writeBuffer(this.drawBuffer, 0, this.drawData, 0, meshes.length * (DRAW_BYTES / 4));
    viewProjections.forEach((matrix, eye) => this.device.queue.writeBuffer(this.eyeBuffers[eye], 0, new Float32Array(matrix.elements)));
  }

  drawItems(pass, eye, items) {
    let current = null;
    for (const item of items) {
      if (item.pipeline !== current) {
        pass.setPipeline(item.pipeline);
        pass.setBindGroup(0, this.eyeGroups[eye]);
        pass.setBindGroup(1, this.drawGroup);
        current = item.pipeline;
      }
      if (item.texture) pass.setBindGroup(2, item.texture.group);
      pass.setVertexBuffer(0, item.geometry.buffer);
      pass.draw(item.geometry.count, 1, 0, item.index);
    }
  }

  // Before an eye's pass: the interface, multisampled, into its own image.
  drawMultisampled(encoder, eye, width, height) {
    this.ensureTargets(width, height);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.multisampled.createView(),
        resolveTarget: this.resolved.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'discard',
      }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    this.drawItems(pass, eye, this.items.filter((item) => !item.punch));
    pass.end();
  }

  // Inside the eye's pass, after the splats: hole punches, then the interface image on top.
  drawOver(pass, eye) {
    this.drawItems(pass, eye, this.items.filter((item) => item.punch));
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, this.compositeGroup);
    pass.draw(3);
  }
}

// A stand-in for the controller models, which need textures this path does not load: a lit handle
// with the tracking ring above it, roughly where a Quest controller sits in the hand.
function controllerShape() {
  const shape = new THREE.Group();
  const part = (geometry, color) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
    mesh.userData.shaded = true;
    return mesh;
  };
  const handle = part(new THREE.CapsuleGeometry(0.017, 0.07, 8, 24), 0x34373c);
  handle.rotation.x = Math.PI / 2 - 0.35;
  handle.position.set(0, -0.012, 0.045);
  const top = part(new THREE.CylinderGeometry(0.024, 0.024, 0.014, 32), 0x3d4046);
  top.rotation.x = 0.35;
  top.position.set(0, 0.006, 0.004);
  const stick = part(new THREE.CylinderGeometry(0.007, 0.008, 0.008, 24), 0x1f2124);
  stick.rotation.x = 0.35;
  stick.position.set(0, 0.016, 0.006);
  const ring = part(new THREE.TorusGeometry(0.035, 0.0055, 16, 72), 0xa3a6ab);
  ring.rotation.x = -0.55;
  ring.position.set(0, 0.014, -0.024);
  shape.add(handle, top, stick, ring);
  return shape;
}

export class WebGpuXr {
  constructor({ computeRenderer, scene, rig, frameBufferScale = 1, foveation = 0 }) {
    this.computeRenderer = computeRenderer;
    this.device = computeRenderer.device;
    this.scene = scene;
    this.rig = rig;
    this.frameBufferScale = frameBufferScale;
    this.foveation = foveation;
    this.presenting = false;
    this.session = null;
    this.binding = null;
    this.projectionLayer = null;
    this.referenceSpace = null;
    this.frame = null;
    this.pose = null;
    this.overlay = null;
    // Callbacks: onStart(), onEnd(), onFrame(time) for input and interface, before drawing.
    this.onStart = null;
    this.onEnd = null;
    this.onFrame = null;
    // The head's pose in the world, like three.js's XR camera; matrixWorld is set every frame.
    this.head = new THREE.Object3D();
    this.head.matrixAutoUpdate = false;
    this.head.matrixWorldAutoUpdate = false;
    this.headLocal = new THREE.Matrix4();
    this.eyeWorld = new THREE.Matrix4();
    this.eyes = Array.from({ length: MAX_EYES }, () => ({ view: new THREE.Matrix4(), projection: new THREE.Matrix4(), viewProjection: new THREE.Matrix4() }));
    this.headPosition = new THREE.Vector3();
    this.sources = [null, null];
    this.controllers = [0, 1].map(() => new THREE.Group());
    this.grips = [0, 1].map(() => {
      const grip = new THREE.Group();
      grip.add(controllerShape());
      grip.visible = false;
      return grip;
    });
    for (const group of [...this.controllers, ...this.grips]) rig.add(group);
    this.onXRFrame = this.onXRFrame.bind(this);

    const xr = this;
    // What the VR browser needs from three.js's renderer, backed by this session.
    this.adapter = {
      xr: {
        getController: (index) => xr.controllers[index],
        getControllerGrip: (index) => xr.grips[index],
        getCamera: () => xr.head,
        getSession: () => xr.session,
        getBinding: () => xr.binding,
        getBaseLayer: () => xr.projectionLayer,
        getReferenceSpace: () => xr.referenceSpace,
        getFrame: () => xr.frame,
        controllerModels: false,
        // Quest Browser shows no quad layers behind a WebGPU projection layer; the overlay renderer
        // draws the panel and the loading card as textured meshes instead.
        quadLayers: false,
      },
    };
  }

  async start() {
    if (this.session) return;
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['webgpu'],
      optionalFeatures: ['hand-tracking'],
    });
    try {
      this.binding = new XRGPUBinding(session, this.device);
      this.format = this.binding.getPreferredColorFormat();
      // Quest Browser ignores fixed foveation on WebGPU layers; the compute renderer foveates the splats itself.
      this.projectionLayer = this.binding.createProjectionLayer({ colorFormat: this.format, scaleFactor: this.frameBufferScale });
      session.updateRenderState({ layers: [this.projectionLayer], depthNear: 0.01, depthFar: 1000 });
      this.referenceSpace = await session.requestReferenceSpace('local');
    } catch (error) {
      session.end().catch(() => {});
      this.binding = null;
      throw error;
    }
    this.session = session;
    this.presenting = true;
    if (this.overlay?.format !== this.format) {
      this.overlay = new OverlayRenderer(this.device, this.format);
      this.overlay.format = this.format;
    }
    session.addEventListener('inputsourceschange', (event) => {
      for (const source of event.removed) this.disconnect(source);
      for (const source of event.added) this.connect(source);
    });
    for (const type of ['selectstart', 'selectend']) {
      session.addEventListener(type, (event) => {
        const slot = this.sources.indexOf(event.inputSource);
        if (slot >= 0) this.controllers[slot].dispatchEvent({ type, data: event.inputSource });
      });
    }
    session.addEventListener('end', () => this.ended());
    for (const source of session.inputSources) this.connect(source);
    this.onStart?.();
    session.requestAnimationFrame(this.onXRFrame);
  }

  end() {
    return this.session?.end();
  }

  ended() {
    for (const source of [...this.sources]) if (source) this.disconnect(source);
    this.session = null;
    this.binding = null;
    this.projectionLayer = null;
    this.frame = null;
    this.pose = null;
    this.presenting = false;
    this.onEnd?.();
  }

  connect(source) {
    if (this.sources.includes(source)) return;
    const slot = this.sources.indexOf(null);
    if (slot < 0) return;
    this.sources[slot] = source;
    this.controllers[slot].dispatchEvent({ type: 'connected', data: source });
  }

  disconnect(source) {
    const slot = this.sources.indexOf(source);
    if (slot < 0) return;
    this.sources[slot] = null;
    this.grips[slot].visible = false;
    this.controllers[slot].dispatchEvent({ type: 'disconnected', data: source });
  }

  // Controller and grip poses in the reference space, which is the rig's local space.
  updateInputs(frame) {
    this.sources.forEach((source, slot) => {
      if (!source) return;
      const ray = frame.getPose(source.targetRaySpace, this.referenceSpace);
      if (ray) {
        const controller = this.controllers[slot];
        controller.matrix.fromArray(ray.transform.matrix);
        controller.matrix.decompose(controller.position, controller.quaternion, controller.scale);
      }
      const gripPose = source.gripSpace ? frame.getPose(source.gripSpace, this.referenceSpace) : null;
      const grip = this.grips[slot];
      grip.visible = !!gripPose && !source.hand;
      if (gripPose) {
        grip.matrix.fromArray(gripPose.transform.matrix);
        grip.matrix.decompose(grip.position, grip.quaternion, grip.scale);
      }
    });
  }

  updateHead() {
    this.rig.updateMatrixWorld(true);
    this.head.matrixWorld.multiplyMatrices(this.rig.matrixWorld, this.headLocal);
  }

  onXRFrame(time, frame) {
    if (!this.session) return;
    this.session.requestAnimationFrame(this.onXRFrame);
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!pose) return;
    this.frame = frame;
    this.pose = pose;
    this.headLocal.fromArray(pose.transform.matrix);
    this.updateInputs(frame);
    this.updateHead();
    this.onFrame?.(time);
  }

  // Draws this frame. splats: { mesh (ComputeSplats) or null, startView, depthRange, stretch,
  // depthColors, ambilight }. headLocked: [[mesh, offset matrix]] pinned to the head before drawing.
  render({ mesh, startView, depthRange, stretch, depthColors, ambilight }, headLocked = []) {
    if (!this.pose) return;
    this.updateHead();
    for (const [object, offset] of headLocked) object.matrixWorld.multiplyMatrices(this.head.matrixWorld, offset);
    this.scene.updateMatrixWorld();
    const views = this.pose.views.slice(0, MAX_EYES);
    const targets = [];
    const viewports = [];
    views.forEach((view, eye) => {
      const subImage = this.binding.getViewSubImage(this.projectionLayer, view);
      const { x, y, width, height } = subImage.viewport;
      viewports.push([x, y, width, height]);
      targets.push({ view: subImage.colorTexture.createView(subImage.getViewDescriptor()), format: this.format, eyes: [eye] });
      const matrices = this.eyes[eye];
      this.eyeWorld.multiplyMatrices(this.rig.matrixWorld, new THREE.Matrix4().fromArray(view.transform.matrix));
      matrices.view.copy(this.eyeWorld).invert();
      matrices.projection.fromArray(view.projectionMatrix);
      matrices.viewProjection.multiplyMatrices(matrices.projection, matrices.view);
    });
    this.overlay.prepare(this.scene, this.eyes.slice(0, views.length).map((eye) => eye.viewProjection));
    this.headPosition.setFromMatrixPosition(this.head.matrixWorld);
    let splats = null;
    let options = null;
    if (mesh) {
      mesh.updateMatrixWorld();
      splats = mesh.gpu;
      options = {
        model: mesh.matrixWorld,
        views: this.eyes.slice(0, views.length).map(({ view, projection }) => ({ view, projection })),
        origin: this.headPosition,
        startView,
        depthRange,
        stretch,
        depthColors,
        ambilight,
        // Fewer pixels towards the edge of the lenses, where they are hardly seen.
        foveation: FOVEATION_STRENGTH * this.foveation,
      };
    }
    this.computeRenderer.renderTargets(splats, options, targets, viewports, {
      before: (encoder, eye) => this.overlay.drawMultisampled(encoder, eye, viewports[eye][2], viewports[eye][3]),
      after: (pass, eye) => this.overlay.drawOver(pass, eye),
    });
  }
}
