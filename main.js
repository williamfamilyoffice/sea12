import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { SobelOperatorShader } from 'three/addons/shaders/SobelOperatorShader.js';
import { LuminosityShader } from 'three/addons/shaders/LuminosityShader.js';
import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import GUI from 'lil-gui';

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const world = { backgroundColor: '#000000' };

const scene = new THREE.Scene();
scene.background = new THREE.Color(world.backgroundColor);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.2, 3.2);

// Camera orbit lives on the right mouse button / two-finger touch so the
// left button is free for dragging the globes.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 20;
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: null,
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};

// ---------------------------------------------------------------------------
// Globe geometry helpers
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;

function pointAt(latRad, lonRad, radius) {
  const horiz = Math.cos(latRad) * radius;
  return new THREE.Vector3(
    Math.cos(lonRad) * horiz,
    Math.sin(latRad) * radius,
    Math.sin(lonRad) * horiz
  );
}

// Arc of constant latitude, swept across the visible longitude range.
function latArcPoints(latRad, lonMinRad, lonMaxRad, radius, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const lon = lonMinRad + (i / segments) * (lonMaxRad - lonMinRad);
    pts.push(pointAt(latRad, lon, radius));
  }
  return pts;
}

// Arc of constant longitude (meridian), swept across the visible latitude range.
function lonArcPoints(lonRad, latMinRad, latMaxRad, radius, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const lat = latMinRad + (i / segments) * (latMaxRad - latMinRad);
    pts.push(pointAt(lat, lonRad, radius));
  }
  return pts;
}

// Shared circular sprite so dots render as circles, not the default squares.
const DOT_TEXTURE = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
})();

// ---------------------------------------------------------------------------
// Globe instances — each owns its params, scene group, and GUI folder
// ---------------------------------------------------------------------------
const GLOBE_DEFAULTS = {
  radius: 1,
  latitudeLines: 12,
  longitudeLines: 24,
  segments: 128,
  latColor: '#4cc9f0',
  latOpacity: 0.85,
  lonColor: '#4cc9f0',
  lonOpacity: 0.85,
  strokeWidth: 1,
  spinSpeed: 0.15,
  showPoles: true,
  wireframe: true,
  solid: false,
  surfaceColor: '#101823',
  surfaceOpacity: 1,
  opacityEnabled: true,
  dots: false,
  dotColor: '#ffffff',
  dotSize: 4,
  dotOpacity: 1,
  scaleH: 1,
  scaleV: 1,
  posX: 0,
  posY: 0,
  posZ: 0,
  latMin: -90,
  latMax: 90,
  lonMin: -180,
  lonMax: 180,
};

const globes = [];
let globeCounter = 0;

class Globe {
  constructor(source) {
    this.params = { ...(source ? source.params : GLOBE_DEFAULTS) };
    this.id = ++globeCounter;
    this.params.name = source ? `${source.params.name} copy` : `globe ${this.id}`;
    this.group = new THREE.Group();
    this.lineMaterials = [];
    if (source) {
      // Place the copy beside its source and keep its orientation.
      this.params.posX = source.params.posX + source.params.radius * 2.4;
      this.group.quaternion.copy(source.group.quaternion);
    }
    scene.add(this.group);
    globes.push(this);
    this.build();
    this.makeFolder();
  }

  build() {
    const p = this.params;
    this.group.traverse((obj) => {
      if (obj.isLine || obj.isMesh || obj.isPoints) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
    this.group.clear();
    this.lineMaterials = [];
    this.group.position.set(p.posX, p.posY, p.posZ);
    // Horizontal scale covers both ground-plane axes; vertical is pole-to-pole.
    this.group.scale.set(p.scaleH, p.scaleV, p.scaleH);

    // Mask window: only lat/lon within these ranges is built.
    const latMin = Math.min(p.latMin, p.latMax) * DEG;
    const latMax = Math.max(p.latMin, p.latMax) * DEG;
    const lonMin = Math.min(p.lonMin, p.lonMax) * DEG;
    const lonMax = Math.max(p.lonMin, p.lonMax) * DEG;
    const masked = latMax - latMin < Math.PI || lonMax - lonMin < 2 * Math.PI;

    // Master opacity switch: off renders every element fully opaque.
    const op = (v) => (p.opacityEnabled ? v : 1);

    // The lat/lon grid, shared by the wireframe lines and intersection dots.
    // Cut-edge lines are added when masked, even off the grid spacing.
    const lats = new Set();
    for (let i = 1; i < p.latitudeLines; i++) {
      const lat = Math.PI / 2 - (i / p.latitudeLines) * Math.PI;
      if (lat >= latMin && lat <= latMax) lats.add(lat);
    }
    if (masked) {
      if (latMin > -Math.PI / 2) lats.add(latMin);
      if (latMax < Math.PI / 2) lats.add(latMax);
    }
    const lons = new Set();
    const lonStep = Math.PI / p.longitudeLines;
    for (let i = 0; i < p.longitudeLines * 2; i++) {
      const lon = -Math.PI + i * lonStep;
      if (lon >= lonMin && lon <= lonMax) lons.add(lon);
    }
    if (masked && lonMax - lonMin < 2 * Math.PI) {
      lons.add(lonMin);
      lons.add(lonMax);
    }

    // Line2/LineMaterial ("fat lines") because LineBasicMaterial.linewidth is
    // ignored by WebGL — this renders strokes at a real pixel width.
    const lineMaterial = (color, opacity) => {
      const material = new LineMaterial({
        color,
        linewidth: p.strokeWidth,
        transparent: true,
        opacity,
        // Translucent lines must not write depth, or their invisible pixels
        // would occlude dots/lines behind them.
        depthWrite: opacity >= 1,
      });
      material.resolution.set(window.innerWidth, window.innerHeight);
      this.lineMaterials.push(material);
      return material;
    };
    const latOpacity = op(p.latOpacity);
    const lonOpacity = op(p.lonOpacity);
    const latMaterial = lineMaterial(p.latColor, latOpacity);
    const lonMaterial = lineMaterial(p.lonColor, lonOpacity);

    const addLine = (points, material) => {
      const geometry = new LineGeometry();
      geometry.setPositions(points.flatMap((pt) => [pt.x, pt.y, pt.z]));
      this.group.add(new Line2(geometry, material));
    };

    // Fully transparent lines are skipped outright, not drawn invisibly.
    if (p.wireframe) {
      if (latOpacity > 0) {
        for (const lat of lats) {
          addLine(latArcPoints(lat, lonMin, lonMax, p.radius, p.segments), latMaterial);
        }
      }
      if (lonOpacity > 0) {
        for (const lon of lons) {
          addLine(lonArcPoints(lon, latMin, latMax, p.radius, p.segments), lonMaterial);
        }
      }
    }

    // Dots at every lat/lon grid intersection.
    if (p.dots && lats.size && lons.size) {
      const positions = [];
      for (const lat of lats) {
        for (const lon of lons) {
          const pt = pointAt(lat, lon, p.radius);
          positions.push(pt.x, pt.y, pt.z);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color: p.dotColor,
        size: p.dotSize, // screen pixels — sizeAttenuation off
        sizeAttenuation: false,
        map: DOT_TEXTURE, // circular sprite instead of the default square
        alphaTest: 0.5,
        transparent: true,
        opacity: op(p.dotOpacity),
      });
      this.group.add(new THREE.Points(geometry, material));
    }

    // Opaque inner surface: fills the globe so it reads as solid and occludes
    // the far-side lines. Slightly undersized to avoid z-fighting with them.
    // Built over the same mask window as the wireframe; DoubleSide so the
    // inside face is visible through the masked-away opening.
    if (p.solid) {
      const geometry = new THREE.SphereGeometry(
        p.radius * 0.995,
        64,
        32,
        Math.PI - lonMax, // SphereGeometry azimuth runs opposite to our lon
        lonMax - lonMin,
        Math.PI / 2 - latMax,
        latMax - latMin
      );
      const surface = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: p.surfaceColor,
          side: THREE.DoubleSide,
          transparent: op(p.surfaceOpacity) < 1,
          opacity: op(p.surfaceOpacity),
        })
      );
      this.group.add(surface);
    }

    // Tiny caps so the poles read as points (only for unmasked poles).
    if (p.showPoles) {
      const capGeometry = new THREE.SphereGeometry(p.radius * 0.008, 8, 8);
      const capMaterial = new THREE.MeshBasicMaterial({ color: p.lonColor });
      for (const sign of [1, -1]) {
        const latPole = (sign * Math.PI) / 2;
        if (latPole < latMin || latPole > latMax) continue;
        const cap = new THREE.Mesh(capGeometry, capMaterial);
        cap.position.y = sign * p.radius;
        this.group.add(cap);
      }
    }
  }

  makeFolder() {
    const p = this.params;
    const rebuild = () => this.build();
    const folder = gui.addFolder(p.name);
    this.folder = folder;
    folder.add(p, 'name').name('rename').onChange((v) => folder.title(v));
    folder.add({ duplicate: () => new Globe(this) }, 'duplicate');
    folder.add({ remove: () => this.remove() }, 'remove');
    folder.add(p, 'radius', 0.2, 3).onChange(rebuild);
    folder.add(p, 'scaleH', 0.1, 3).name('↔ scale horizontal').onChange(rebuild);
    folder.add(p, 'scaleV', 0.1, 3).name('↕ scale vertical').onChange(rebuild);
    folder.add(p, 'latitudeLines', 2, 48, 1).name('↕ latitude lines').onChange(rebuild);
    folder.add(p, 'longitudeLines', 2, 72, 1).name('↔ longitude lines').onChange(rebuild);
    folder.add(p, 'segments', 16, 256, 1).onChange(rebuild);
    folder.addColor(p, 'latColor').name('↕ lat line color').onChange(rebuild);
    folder.add(p, 'latOpacity', 0, 1).name('↕ lat opacity').onChange(rebuild);
    folder.addColor(p, 'lonColor').name('↔ lon line color').onChange(rebuild);
    folder.add(p, 'lonOpacity', 0, 1).name('↔ lon opacity').onChange(rebuild);
    folder.add(p, 'strokeWidth', 0.5, 12, 0.5).name('stroke width (px)').onChange(rebuild);
    folder.add(p, 'spinSpeed', -5, 5);
    folder.add(p, 'showPoles').onChange(rebuild);
    folder.add(p, 'wireframe').onChange(rebuild);
    folder.add(p, 'solid').onChange(rebuild);
    folder.addColor(p, 'surfaceColor').onChange(rebuild);
    folder.add(p, 'surfaceOpacity', 0, 1).onChange(rebuild);
    folder.add(p, 'opacityEnabled').name('opacity on/off').onChange(rebuild);
    folder.add(p, 'dots').name('intersection dots').onChange(rebuild);
    folder.addColor(p, 'dotColor').name('dot color').onChange(rebuild);
    folder.add(p, 'dotSize', 1, 16, 0.5).name('dot size (px)').onChange(rebuild);
    folder.add(p, 'dotOpacity', 0, 1).name('dot opacity').onChange(rebuild);

    const positionFolder = folder.addFolder('position');
    positionFolder.add(p, 'posX', -6, 6).onChange(rebuild);
    positionFolder.add(p, 'posY', -6, 6).onChange(rebuild);
    positionFolder.add(p, 'posZ', -6, 6).onChange(rebuild);
    positionFolder.close();

    const maskFolder = folder.addFolder('mask');
    maskFolder.add(p, 'latMin', -90, 90, 1).name('↕ latMin').onChange(rebuild);
    maskFolder.add(p, 'latMax', -90, 90, 1).name('↕ latMax').onChange(rebuild);
    maskFolder.add(p, 'lonMin', -180, 180, 1).name('↔ lonMin').onChange(rebuild);
    maskFolder.add(p, 'lonMax', -180, 180, 1).name('↔ lonMax').onChange(rebuild);
    maskFolder.close();
  }

  remove() {
    if (globes.length === 1) return; // keep at least one globe
    this.group.traverse((obj) => {
      if (obj.isLine || obj.isMesh || obj.isPoints) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
    scene.remove(this.group);
    this.folder.destroy();
    globes.splice(globes.indexOf(this), 1);
  }
}

// ---------------------------------------------------------------------------
// Post-processing chain. Every pass is always in the chain; toggles flip
// `enabled` so there's nothing to rebuild.
//   render → trails → bloom → blur → rgb shift → edge detect → output
// ---------------------------------------------------------------------------
// Gradient blur: strength ramps across the screen instead of being uniform.
// A 24-tap spiral disc kernel whose radius scales with the gradient.
const ProgressiveBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    amount: { value: 6 },
    mode: { value: 0 }, // 0: bottom, 1: top, 2: edges
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float amount;
    uniform int mode;
    varying vec2 vUv;
    void main() {
      float s;
      if (mode == 0) s = 1.0 - vUv.y;
      else if (mode == 1) s = vUv.y;
      else s = distance(vUv, vec2(0.5)) * 1.8;
      s = smoothstep(0.1, 0.95, s);
      float radius = amount * s * 2.0;
      vec4 sum = vec4(0.0);
      for (int i = 0; i < 24; i++) {
        float t = (float(i) + 0.5) / 24.0;
        float a = float(i) * 2.39996; // golden angle spiral
        vec2 offset = vec2(cos(a), sin(a)) * sqrt(t) * radius;
        sum += texture2D(tDiffuse, vUv + offset / resolution);
      }
      gl_FragColor = sum / 24.0;
    }`,
};

// Luminance threshold: clips everything below `level` to black, so the smooth
// afterimage falloff becomes a hard-edged, high-contrast trail.
const ThresholdShader = {
  uniforms: {
    tDiffuse: { value: null },
    level: { value: 0.25 },
    softness: { value: 0.05 },
    solid: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float level;
    uniform float softness;
    uniform float solid;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Negative softness inverts the cut: bright pixels are clipped and only
      // the faint trail survives. abs() keeps smoothstep's edges ordered.
      float soft = max(abs(softness), 1e-4);
      float m = smoothstep(level - soft, level + soft, lum);
      if (softness < 0.0) m = 1.0 - m;
      vec3 color = c.rgb;
      // Solid mode: renormalize surviving pixels to full brightness so the
      // trail reads as a flat shape instead of an exponential fade.
      if (solid > 0.5) {
        float peak = max(max(c.r, c.g), c.b);
        if (peak > 1e-4) color = c.rgb / peak;
      }
      gl_FragColor = vec4(color * m, c.a);
    }`,
};

const fx = {
  bloom: false,
  bloomStrength: 1.2,
  bloomRadius: 0.5,
  bloomThreshold: 0,
  blur: false,
  blurAmount: 2,
  blurProgressive: false,
  blurGradient: 'bottom',
  edges: false,
  rgbShift: false,
  rgbShiftAmount: 0.003,
  trails: false,
  trailsDuration: 1.5, // seconds until a trail fades to ~1%
  trailsPersist: false,
  trailsThreshold: false,
  trailsThresholdLevel: 0.25,
  trailsThresholdSoftness: 0.05,
  trailsSolid: false,
};

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const trailsPass = new AfterimagePass();
composer.addPass(trailsPass);

const trailsThresholdPass = new ShaderPass(ThresholdShader);
composer.addPass(trailsThresholdPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  fx.bloomStrength,
  fx.bloomRadius,
  fx.bloomThreshold
);
composer.addPass(bloomPass);

const blurH = new ShaderPass(HorizontalBlurShader);
const blurV = new ShaderPass(VerticalBlurShader);
composer.addPass(blurH);
composer.addPass(blurV);

const progBlurPass = new ShaderPass(ProgressiveBlurShader);
composer.addPass(progBlurPass);

const rgbShiftPass = new ShaderPass(RGBShiftShader);
composer.addPass(rgbShiftPass);

// Sobel works on luminance, so a grayscale pass feeds it.
const grayPass = new ShaderPass(LuminosityShader);
const sobelPass = new ShaderPass(SobelOperatorShader);
composer.addPass(grayPass);
composer.addPass(sobelPass);

composer.addPass(new OutputPass());

function applyFx() {
  trailsPass.enabled = fx.trails;
  // Convert an intuitive duration into the per-frame damp factor: after
  // `trailsDuration` seconds (at ~60fps) the trail decays to 1%. Persist
  // mode never decays — trails accumulate like paint.
  trailsPass.uniforms.damp.value = fx.trailsPersist
    ? 1
    : Math.pow(0.01, 1 / (60 * fx.trailsDuration));
  // Solid mode needs the threshold gate too — renormalizing near-black noise
  // to full brightness without a cutoff would blow up the whole frame.
  trailsThresholdPass.enabled = fx.trails && (fx.trailsThreshold || fx.trailsSolid);
  trailsThresholdPass.uniforms.level.value = fx.trailsThresholdLevel;
  trailsThresholdPass.uniforms.softness.value = fx.trailsThresholdSoftness;
  trailsThresholdPass.uniforms.solid.value = fx.trailsSolid ? 1 : 0;
  bloomPass.enabled = fx.bloom;
  bloomPass.strength = fx.bloomStrength;
  bloomPass.radius = fx.bloomRadius;
  bloomPass.threshold = fx.bloomThreshold;
  blurH.enabled = blurV.enabled = fx.blur && !fx.blurProgressive;
  blurH.uniforms.h.value = fx.blurAmount / window.innerWidth;
  blurV.uniforms.v.value = fx.blurAmount / window.innerHeight;
  progBlurPass.enabled = fx.blur && fx.blurProgressive;
  progBlurPass.uniforms.amount.value = fx.blurAmount;
  progBlurPass.uniforms.mode.value = { bottom: 0, top: 1, edges: 2 }[fx.blurGradient];
  progBlurPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
  rgbShiftPass.enabled = fx.rgbShift;
  rgbShiftPass.uniforms.amount.value = fx.rgbShiftAmount;
  grayPass.enabled = sobelPass.enabled = fx.edges;
  const dpr = renderer.getPixelRatio();
  sobelPass.uniforms.resolution.value.set(window.innerWidth * dpr, window.innerHeight * dpr);
}

// ---------------------------------------------------------------------------
// Drag to rotate every globe about its own center (world axes, respecting
// per-axis locks)
//   left-drag:        horizontal → Y axis, vertical → X axis
//   shift+left-drag:  horizontal → Z axis (roll)
// ---------------------------------------------------------------------------
const drag = {
  dragSensitivity: 1,
  lockX: false,
  lockY: false,
  lockZ: false,
};

const DRAG_SPEED = 0.005;
let dragging = false;
let lastPointer = { x: 0, y: 0 };

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function rotateGlobes(axis, angle, locked) {
  if (locked || angle === 0) return;
  for (const g of globes) g.group.rotateOnWorldAxis(axis, angle);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  lastPointer = { x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  lastPointer = { x: e.clientX, y: e.clientY };
  const k = DRAG_SPEED * drag.dragSensitivity;
  if (e.shiftKey) {
    rotateGlobes(Z_AXIS, -dx * k, drag.lockZ);
  } else {
    rotateGlobes(Y_AXIS, dx * k, drag.lockY);
    rotateGlobes(X_AXIS, dy * k, drag.lockX);
  }
});

renderer.domElement.addEventListener('pointerup', () => (dragging = false));
renderer.domElement.addEventListener('pointercancel', () => (dragging = false));

// ---------------------------------------------------------------------------
// GUI — global controls first, then one folder per globe
// ---------------------------------------------------------------------------
const gui = new GUI({ title: 'sandbox' });

function resetAll() {
  // Tear down every globe, restore the global controllers to their initial
  // values (this re-applies fx and background via their onChange handlers),
  // then start over with a single default globe.
  while (globes.length) {
    const g = globes.pop();
    g.group.traverse((obj) => {
      if (obj.isLine || obj.isMesh || obj.isPoints) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
    scene.remove(g.group);
    g.folder.destroy();
  }
  gui.reset();
  camera.position.set(0, 1.2, 3.2);
  controls.target.set(0, 0, 0);
  globeCounter = 0;
  new Globe();
}

gui.add({ 'reset all': resetAll }, 'reset all');
gui.addColor(world, 'backgroundColor').onChange((v) => scene.background.set(v));

const fxFolder = gui.addFolder('effects');
fxFolder.add(fx, 'bloom').name('outer glow').onChange(applyFx);
fxFolder.add(fx, 'bloomStrength', 0, 3).onChange(applyFx);
fxFolder.add(fx, 'bloomRadius', 0, 1).onChange(applyFx);
fxFolder.add(fx, 'bloomThreshold', 0, 1).onChange(applyFx);
fxFolder.add(fx, 'blur').name('gaussian blur').onChange(applyFx);
fxFolder.add(fx, 'blurAmount', 0, 10).onChange(applyFx);
fxFolder.add(fx, 'blurProgressive').name('progressive blur').onChange(applyFx);
fxFolder.add(fx, 'blurGradient', ['bottom', 'top', 'edges']).name('blur gradient').onChange(applyFx);
fxFolder.add(fx, 'edges').name('edge detect').onChange(applyFx);
fxFolder.add(fx, 'rgbShift').name('rgb shift').onChange(applyFx);
fxFolder.add(fx, 'rgbShiftAmount', 0, 0.02).onChange(applyFx);
fxFolder.add(fx, 'trails').name('motion trails').onChange(applyFx);
fxFolder.add(fx, 'trailsDuration', 0.05, 30).name('trail duration (s)').onChange(applyFx);
fxFolder.add(fx, 'trailsPersist').name('persist forever').onChange(applyFx);
fxFolder.add(fx, 'trailsThreshold').name('trail threshold').onChange(applyFx);
fxFolder.add(fx, 'trailsSolid').name('solid trails').onChange(applyFx);
fxFolder.add(fx, 'trailsThresholdLevel', 0, 2).name('threshold level').onChange(applyFx);
fxFolder.add(fx, 'trailsThresholdSoftness', -1, 1).name('threshold softness').onChange(applyFx);
fxFolder.close();

const dragFolder = gui.addFolder('drag');
dragFolder.add(drag, 'dragSensitivity', 0.1, 3);
dragFolder.add(drag, 'lockX').name('lock X axis');
dragFolder.add(drag, 'lockY').name('lock Y axis');
dragFolder.add(drag, 'lockZ').name('lock Z axis');
dragFolder.close();

applyFx();
new Globe();

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (!drag.lockY) {
    for (const g of globes) g.group.rotateOnWorldAxis(Y_AXIS, g.params.spinSpeed * dt);
  }
  controls.update();
  composer.render();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  applyFx(); // refresh resolution-dependent uniforms
  for (const g of globes) {
    for (const m of g.lineMaterials) m.resolution.set(window.innerWidth, window.innerHeight);
  }
});
