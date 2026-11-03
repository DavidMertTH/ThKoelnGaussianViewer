import * as THREE from 'three';

// The flat view as a window into the scene: the screen is a fixed rectangle at the orbit target's
// distance, filling the camera's field of view. The eyes look through it from where the head is, each
// with an off-axis frustum through the same rectangle, so the picture behind it shifts the way it would
// behind real glass. The red-cyan view and the head tracker both draw through these eyes.

// Dubois' least-squares red-cyan matrices, column by column (input red, green, blue), for linear colour.
export const ANAGLYPH_LEFT = [0.4561, -0.0400822, -0.0152161, 0.500484, -0.0378246, -0.0205971, 0.176381, -0.0157589, -0.00546856];
export const ANAGLYPH_RIGHT = [-0.0434706, 0.378476, -0.0721527, -0.0879388, 0.73364, -0.112961, -0.00155529, -0.0184503, 1.2264];

// Eye separation as a share of the screen's distance. The true ratio, about 6.4 cm at 60 cm, puts the
// far parts of a scene a full eye width apart on the screen; a third of it stays comfortable.
const EYE_SEPARATION = 0.035;
const eyeOffset = new THREE.Matrix4();

export class ScreenViews {
  constructor() {
    this.eyes = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
    this.count = 1;
  }

  // camera: the orbit camera; distance: from it to the screen plane; head: the head's offset from where
  // it sat when tracking began, in units of that viewing distance (x right, y up, z back towards the
  // viewer), or null; stereo: two eyes for the red-cyan view.
  update(camera, distance, head, stereo) {
    camera.updateMatrixWorld();
    this.count = stereo ? 2 : 1;
    const halfHeight = (distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / camera.zoom;
    const halfWidth = halfHeight * camera.aspect;
    const headX = (head?.x ?? 0) * distance;
    const headY = (head?.y ?? 0) * distance;
    const headZ = (head?.z ?? 0) * distance;
    for (let index = 0; index < this.count; index += 1) {
      const eye = this.eyes[index];
      const side = stereo ? (index === 0 ? -0.5 : 0.5) : 0;
      const x = headX + side * EYE_SEPARATION * distance;
      // From the eye to the screen plane, which stays where it is when the head comes closer.
      const depth = Math.max(distance + headZ, distance * 0.2);
      const scale = camera.near / depth;
      eye.near = camera.near;
      eye.far = camera.far;
      eye.fov = camera.fov;
      eye.aspect = camera.aspect;
      eye.projectionMatrix.makePerspective(
        (-halfWidth - x) * scale, (halfWidth - x) * scale,
        (halfHeight - headY) * scale, (-halfHeight - headY) * scale,
        camera.near, camera.far,
      );
      eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
      eye.matrix.multiplyMatrices(camera.matrixWorld, eyeOffset.makeTranslation(x, headY, headZ));
      eye.matrix.decompose(eye.position, eye.quaternion, eye.scale);
      eye.updateMatrixWorld(true);
    }
    return this.eyes.slice(0, this.count);
  }
}

// The red-cyan view with Spark on WebGL: each eye renders into its own image, and a full-screen pass
// mixes the two over the page background.
export class WebGlAnaglyph {
  constructor(renderer, background) {
    this.renderer = renderer;
    const options = { type: THREE.HalfFloatType, depthBuffer: true };
    this.targets = [new THREE.WebGLRenderTarget(1, 1, options), new THREE.WebGLRenderTarget(1, 1, options)];
    this.size = new THREE.Vector2();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        left: { value: this.targets[0].texture },
        right: { value: this.targets[1].texture },
        leftMatrix: { value: new THREE.Matrix3().fromArray(ANAGLYPH_LEFT) },
        rightMatrix: { value: new THREE.Matrix3().fromArray(ANAGLYPH_RIGHT) },
        background: { value: new THREE.Color(background) },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      // The eye images hold premultiplied linear colour; the canvas takes sRGB.
      fragmentShader: `
        uniform sampler2D left;
        uniform sampler2D right;
        uniform mat3 leftMatrix;
        uniform mat3 rightMatrix;
        uniform vec3 background;
        varying vec2 vUv;
        vec3 toSrgb(vec3 c) {
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
        }
        void main() {
          vec4 l = texture2D(left, vUv);
          vec4 r = texture2D(right, vUv);
          vec3 color = leftMatrix * (l.rgb + background * (1.0 - l.a)) + rightMatrix * (r.rgb + background * (1.0 - r.a));
          gl_FragColor = vec4(toSrgb(clamp(color, 0.0, 1.0)), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.material.uniforms.background.value.convertSRGBToLinear();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadCamera = new THREE.OrthographicCamera();
  }

  render(scene, eyes) {
    const { renderer } = this;
    renderer.getDrawingBufferSize(this.size);
    for (const target of this.targets) {
      if (target.width !== this.size.x || target.height !== this.size.y) target.setSize(this.size.x, this.size.y);
    }
    const previous = renderer.getRenderTarget();
    eyes.forEach((eye, index) => {
      renderer.setRenderTarget(this.targets[index]);
      renderer.clear();
      renderer.render(scene, eye);
    });
    renderer.setRenderTarget(previous);
    renderer.render(this.quad, this.quadCamera);
  }
}
