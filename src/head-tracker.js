import * as THREE from 'three';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

// Follows the viewer's head with the webcam, so the flat view can look through the screen as through a
// window. MediaPipe and its WebAssembly come with the viewer; only the small face model loads from the
// internet, the first time the tracker starts.
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
// Most laptop and USB webcams see about 60° across.
const CAMERA_HALF_WIDTH = Math.tan(THREE.MathUtils.degToRad(30));
// Where the head sits over the first frames is the middle; the offsets count from there.
const CALIBRATION_FRAMES = 12;
// Each detection moves the measured head this far towards what it saw, which calms the detector's jitter.
const MEASURE_SMOOTHING = 0.5;
// How quickly the view follows the measured head, per second.
const FOLLOW_RATE = 14;
// Without a face for this long, the view drifts back to the middle.
const LOST_AFTER_MS = 700;
const MAX_SIDEWAYS = 0.6;

let detectorPromise = null;

function loadDetector() {
  detectorPromise ??= (async () => {
    const { FaceDetector } = await import('@mediapipe/tasks-vision');
    const create = (delegate) => FaceDetector.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    // Not every browser lets MediaPipe run on the GPU; the CPU is fast enough for one face.
    try {
      return await create('GPU');
    } catch (error) {
      console.warn('The face detector runs on the CPU.', error);
      return create('CPU');
    }
  })().catch((error) => {
    detectorPromise = null;
    throw error;
  });
  return detectorPromise;
}

export class HeadTracker {
  constructor() {
    // The head's offset from the middle, in units of the viewing distance there: x right, y up,
    // z back from the screen.
    this.offset = new THREE.Vector3();
    this.measured = new THREE.Vector3();
    this.active = false;
    this.stream = null;
    this.video = null;
    this.lastFaceAt = 0;
    this.calibration = [];
    this.neutral = null;
  }

  async start() {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use a camera here.');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      this.detector = await loadDetector();
      this.stream = stream;
      this.video = video;
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
    this.calibration = [];
    this.neutral = null;
    this.measured.set(0, 0, 0);
    this.lastFaceAt = performance.now();
    this.active = true;
    this.watch();
  }

  stop() {
    this.active = false;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.offset.set(0, 0, 0);
  }

  watch() {
    const video = this.video;
    let lastTime = -1;
    const next = () => {
      if (!this.active || this.video !== video) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
      else requestAnimationFrame(frame);
    };
    const frame = () => {
      if (!this.active || this.video !== video) return;
      if (video.currentTime !== lastTime && video.videoWidth) {
        lastTime = video.currentTime;
        try {
          this.measure(this.detector.detectForVideo(video, performance.now()).detections);
        } catch (error) {
          console.warn('Head tracking skipped a frame.', error);
        }
      }
      next();
    };
    next();
  }

  measure(detections) {
    const video = this.video;
    // The largest face is the one in front of the screen.
    let face = null;
    for (const detection of detections ?? []) {
      if (!face || detection.boundingBox.width > face.boundingBox.width) face = detection;
    }
    if (!face || face.keypoints.length < 2) return;
    this.lastFaceAt = performance.now();
    const [rightEye, leftEye] = face.keypoints;
    const sample = {
      x: (rightEye.x + leftEye.x) / 2,
      y: (rightEye.y + leftEye.y) / 2,
      size: face.boundingBox.width / video.videoWidth,
    };
    if (!this.neutral) {
      this.calibration.push(sample);
      if (this.calibration.length < CALIBRATION_FRAMES) return;
      const mean = (key) => this.calibration.reduce((sum, item) => sum + item[key], 0) / this.calibration.length;
      this.neutral = { x: mean('x'), y: mean('y'), size: mean('size') };
    }
    const halfHeight = (CAMERA_HALF_WIDTH * video.videoHeight) / video.videoWidth;
    // How far away the head is compared with the middle; a face half as wide is twice as far.
    const distance = this.neutral.size / sample.size;
    // Sideways in units of the middle's viewing distance. The camera sees the viewer mirrored.
    const across = (u, middle, half) => distance * (u - 0.5) * 2 * half - (middle - 0.5) * 2 * half;
    this.measured.lerp(new THREE.Vector3(
      THREE.MathUtils.clamp(-across(sample.x, this.neutral.x, CAMERA_HALF_WIDTH), -MAX_SIDEWAYS, MAX_SIDEWAYS),
      THREE.MathUtils.clamp(-across(sample.y, this.neutral.y, halfHeight), -MAX_SIDEWAYS, MAX_SIDEWAYS),
      THREE.MathUtils.clamp(distance - 1, -0.5, 1),
    ), MEASURE_SMOOTHING);
  }

  // Once per drawn frame: eases the offset towards the measured head and returns it.
  update(seconds) {
    if (!this.active) return null;
    if (performance.now() - this.lastFaceAt > LOST_AFTER_MS) this.measured.multiplyScalar(0.9);
    this.offset.lerp(this.measured, 1 - Math.exp(-seconds * FOLLOW_RATE));
    return this.offset;
  }
}
