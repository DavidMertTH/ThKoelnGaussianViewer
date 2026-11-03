// Ambilight: the background around the scene takes on the scene's colours, carried outwards and
// blurred, like a TV lighting the wall behind it. It draws on its own small canvas under the splat
// canvases and copies whichever canvas shows the splats after every frame, so it works the same for
// both renderers. VR on WebGPU makes its own from the headset's image (compute-splats.js).
//
// The copy is mipmapped with premultiplied alpha, so every level holds the average colour of the
// splats in its cells and how much of each cell they cover. The shader walks from the coarsest level to
// the finest, and each level replaces the coarser ones where it is covered: next to the scene the colours
// are those of its edge, further out they come from ever larger areas. The farther from the scene, the
// dimmer the light. The canvas is drawn at a fraction of the page's size and blurred by CSS, which
// smooths the blocky cells of the coarse levels.

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  // One triangle covering the canvas.
  uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D image;
uniform float coarsest;
uniform float finest;
uniform float brightness;
in vec2 uv;
out vec4 color;
void main() {
  vec4 whole = textureLod(image, uv, coarsest);
  if (whole.a <= 0.0) {
    color = vec4(0.0);
    return;
  }
  vec3 fill = whole.rgb / whole.a;
  // Follows the finest covered level, as a measure of the distance to the scene.
  float near = coarsest;
  for (float level = coarsest - 1.0; level >= finest; level -= 1.0) {
    vec4 cell = textureLod(image, uv, level);
    if (cell.a <= 0.0) continue;
    float weight = clamp(cell.a * 2.5, 0.0, 1.0);
    fill = mix(fill, cell.rgb / cell.a, weight);
    near = mix(near, level, weight);
  }
  float fade = 1.0 - smoothstep(finest, coarsest, near);
  color = vec4(fill * brightness * mix(0.4, 1.0, fade), 1.0);
}`;

// The ambilight canvas has this fraction of the page's pixels; the finest level used is about this wide.
const SCALE = 1 / 6;
const FINEST_WIDTH = 160;
const BRIGHTNESS = 0.8;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class Ambilight {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ambilight-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    const gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL 2 is not available.');
    this.gl = gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.program = program;
    this.uniforms = Object.fromEntries(['image', 'coarsest', 'finest', 'brightness'].map((name) => [name, gl.getUniformLocation(program, name)]));
    this.texture = null;
    this.textureSize = [0, 0];
    this.levels = 0;
    this.lit = false;
    this.lost = false;
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
    });
  }

  // Immutable storage with every mip level, made again when the image changes size.
  prepareTexture(width, height) {
    const { gl } = this;
    if (this.texture && this.textureSize[0] === width && this.textureSize[1] === height) return;
    if (this.texture) gl.deleteTexture(this.texture);
    this.levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, this.levels, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textureSize = [width, height];
  }

  // source: the canvas the splats were just drawn on, in this same task; null leaves the background dark.
  update(source) {
    if (this.lost) return;
    const { gl } = this;
    if (!source?.width || !source?.height) {
      if (this.lit) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.lit = false;
      }
      return;
    }
    const width = Math.max(1, Math.round(this.canvas.clientWidth * SCALE));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * SCALE));
    if (this.canvas.width !== width || this.canvas.height !== height) Object.assign(this.canvas, { width, height });

    this.prepareTexture(source.width, source.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);

    const coarsest = this.levels - 1;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.image, 0);
    gl.uniform1f(this.uniforms.coarsest, coarsest);
    gl.uniform1f(this.uniforms.finest, Math.min(coarsest, Math.max(0, Math.floor(Math.log2(source.width / FINEST_WIDTH)))));
    gl.uniform1f(this.uniforms.brightness, BRIGHTNESS);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.lit = true;
  }
}
