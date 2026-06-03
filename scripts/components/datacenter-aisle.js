import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Final cinematic grade folded into ONE fullscreen pass (cheaper than three):
//  - luma-preserving desaturation so the oxide-red accent stays the only chroma
//  - additive, shadow-weighted film grain (lives in the blacks where banding shows;
//    a multiplicative FilmShader grain would vanish exactly there)
//  - Eskil radial vignette (the r160 VignetteShader falloff)
// Runs in linear space BEFORE OutputPass, so grain is tone-mapped + sRGB-encoded
// with the image and never bands. uTime is shared with the LED RAF clock; when the
// on-demand loop settles the grain freezes — intended (no idle battery drain).
const GradeGrainVignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.03 },
    uVigOff: { value: 1.12 },
    uVigDark: { value: 1.0 },
    uSat: { value: 0.9 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    #include <common>
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVigOff, uVigDark, uSat;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // luma-preserving desaturation — pulls neutral metal toward grey, leaves red
      float l = luminance(c);
      c = mix(vec3(l), c, uSat);
      // additive grain, weighted toward the shadows so it breaks up dark banding
      float n = rand(fract(vUv + vec2(uTime, uTime * 1.37))) - 0.5;
      c += n * uGrain * (1.0 - 0.6 * l);
      // Eskil vignette: darken with squared radial distance from centre
      vec2 uv = (vUv - 0.5) * uVigOff;
      c = mix(c, vec3(0.0), clamp(dot(uv, uv) * uVigDark, 0.0, 1.0));
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

// Data Center Hot Aisle: a dark, hyper-realistic server hall. Two receding rows
// of black GPU racks line a central aisle; brushed-metal rails catch the IBL,
// perforated fan grilles breathe, and hundreds of status LEDs blink (mostly
// neutral white/amber, sparse oxide-red) — all GPU-driven so the RAF cost stays
// near zero. The camera dollies down the aisle, parallaxes to the cursor, and
// falls back to scroll progress on touch. Structure, IBL, context-loss guard and
// disposable tracking follow scripts/sections/proj-dcauto.js; the camera motion
// uses frame-rate-independent exponential damping with an on-demand RAF that
// STOPS once settled, and the bloom chain isolates the LEDs by luminance.

const OXIDE_RED = '#d64545';
const BG = 0x0a0a0a;
const FOG_COLOR = 0x070707; // == / slightly darker than bg so the aisle dissolves to black

// Frame-rate-INDEPENDENT exponential damp. lambda = responsiveness (1/sec).
// 1 - exp(-lambda*dt) is the closed form of repeated lerping: identical easing
// at 60Hz and 120Hz, stable under frame drops. (Rory Driscoll.)
const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);

  // -------------------------------------------------------------------------
  // Renderer
  // -------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BG, 1); // opaque dark so the bloom composite has clean blacks
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.56; // dialed down: enhanced bloom/glints were washing the hall
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  mount.appendChild(renderer.domElement);

  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = null; // keep the hall a void; reflections come only from scene.environment
  scene.fog = new THREE.FogExp2(FOG_COLOR, 0.058); // denser so the far racks fully dissolve to black (stronger vanishing-point depth)

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);

  // -------------------------------------------------------------------------
  // Environment (IBL) for believable metal reflections, not used as background.
  // RoomEnvironment alone is flat/even, so we add an explicit dim rig below.
  // -------------------------------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  // Dim 3-point rig with a single oxide-red rim (the only chromatic light).
  const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(4, 14, 8);
  const fill = new THREE.DirectionalLight(0xaecbff, 0.35); fill.position.set(-9, 6, 4);
  const rim = new THREE.DirectionalLight(0xd64545, 0.55); rim.position.set(-3, 5, -16);
  scene.add(key, fill, rim);
  scene.add(new THREE.AmbientLight(0x303438, 0.3)); // low ambient so emissive LEDs dominate

  // Track every disposable (geometries, materials, textures) for teardown.
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  // -------------------------------------------------------------------------
  // Canvas / texture helpers (verbatim toolkit from the exemplar)
  // -------------------------------------------------------------------------
  function makeCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }
  function colorTexture(canvas, rx = 1, ry = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }
  function dataTexture(canvas, rx = 1, ry = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }
  function normalTexture(canvas, rx = 1, ry = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }

  // Height (grayscale luminance) -> tangent-space normal map (Sobel).
  function heightToNormalCanvas(srcCanvas, strength = 2.0) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const src = sctx.getImageData(0, 0, w, h).data;
    const out = makeCanvas(w);
    const octx = out.getContext('2d');
    const dst = octx.createImageData(w, h);
    const lum = (x, y) => {
      const xi = (x + w) % w, yi = (y + h) % h;
      const i = (yi * w + xi) * 4;
      return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tl = lum(x - 1, y - 1), t = lum(x, y - 1), tr = lum(x + 1, y - 1);
        const l = lum(x - 1, y), r = lum(x + 1, y);
        const bl = lum(x - 1, y + 1), b = lum(x, y + 1), br = lum(x + 1, y + 1);
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        let nx = -dx * strength, ny = -dy * strength, nz = 1.0;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const i = (y * w + x) * 4;
        dst.data[i] = (nx * 0.5 + 0.5) * 255;
        dst.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        dst.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        dst.data[i + 3] = 255;
      }
    }
    octx.putImageData(dst, 0, 0);
    return out;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -------------------------------------------------------------------------
  // Procedural textures
  // -------------------------------------------------------------------------

  // Black powder-coated panel: micro-orange-peel relief + faint roughness drift.
  // The dominant rack surface — kept dark and slightly soft so the hall reads as a void.
  function makePanelTex({ size = 512, seed = 7 } = {}) {
    const rng = mulberry32(seed);
    const bump = makeCanvas(size);
    const bctx = bump.getContext('2d');
    bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, size, size);
    // orange-peel speckle (powder coat is never perfectly flat)
    for (let i = 0; i < 9000; i++) {
      const x = rng() * size, y = rng() * size, r = 0.6 + rng() * 1.6;
      const g = 110 + (rng() * 60 | 0);
      bctx.fillStyle = `rgba(${g},${g},${g},0.10)`;
      bctx.beginPath(); bctx.arc(x, y, r, 0, Math.PI * 2); bctx.fill();
    }
    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#9e9e9e'; rctx.fillRect(0, 0, size, size); // ~0.62 base roughness
    rctx.globalAlpha = 0.35; rctx.drawImage(bump, 0, 0); rctx.globalAlpha = 1;
    // low-frequency dust grunge (dust is matte/dielectric -> raise roughness, lighter value)
    for (let i = 0; i < 60; i++) {
      const x = rng() * size, y = rng() * size, r = 30 + rng() * 90;
      const g = rctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(210,210,210,${0.04 + rng() * 0.05})`);
      g.addColorStop(1, 'rgba(210,210,210,0)');
      rctx.fillStyle = g; rctx.beginPath(); rctx.arc(x, y, r, 0, Math.PI * 2); rctx.fill();
    }
    // faint vertical drip/dust staining down the chassis fronts (raise roughness in runs)
    for (let i = 0; i < 10; i++) {
      const x = rng() * size, w = 1 + rng() * 3;
      rctx.fillStyle = `rgba(190,190,190,${0.05 + rng() * 0.05})`;
      rctx.fillRect(x, rng() * size * 0.3, w, size * (0.5 + rng() * 0.5));
    }
    return {
      roughnessMap: dataTexture(rough),
      normalMap: normalTexture(heightToNormalCanvas(bump, 0.45)),
    };
  }

  // Orange-peel CLEARCOAT normal: a second, finer dimple map distinct from the
  // panel bump. Real powder coat carries the dimple in the COATING (clearcoatNormalMap),
  // not the pigment — independent of the base normal, low-amplitude so it only
  // flickers the highlight and never deforms the silhouette.
  function makeOrangePeelNormal({ size = 256, seed = 13 } = {}) {
    const rng = mulberry32(seed);
    const h = makeCanvas(size);
    const c = h.getContext('2d');
    c.fillStyle = '#808080'; c.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
      const x = rng() * size, y = rng() * size, r = 2 + rng() * 5;
      const v = 128 + (rng() * 70 - 35) | 0;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
      g.addColorStop(1, 'rgba(128,128,128,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
    return normalTexture(heightToNormalCanvas(h, 0.6));
  }

  // GPU-sled faceplate maps (normal + roughness + AO) baked onto ONE canvas set
  // applied to the existing sled InstancedMesh (zero extra draw calls). Reads as
  // a real blade front: two recessed pull-handle troughs, a central perforated
  // intake band, thin top/bottom seam grooves. The recesses darken in AO and grow
  // rougher (grime collects), so the key light catches the handle lips and the
  // rim light rakes across the mesh band — the dominant "fake CG box" tell, fixed.
  function makeFaceplateTex({ size = 256 } = {}) {
    // height field (grey base; dark = recessed, light = proud lip)
    const bump = makeCanvas(size);
    const bx = bump.getContext('2d');
    bx.fillStyle = '#909090'; bx.fillRect(0, 0, size, size);
    const rough = makeCanvas(size);
    const rx = rough.getContext('2d');
    rx.fillStyle = '#7d7d7d'; rx.fillRect(0, 0, size, size); // ~0.49 base
    const ao = makeCanvas(size);
    const ax = ao.getContext('2d');
    ax.fillStyle = '#ffffff'; ax.fillRect(0, 0, size, size); // white = unoccluded

    const rrect = (ctx, x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    // two horizontal pull-handle troughs (upper + lower thirds)
    for (const cy of [size * 0.26, size * 0.74]) {
      const hx = size * 0.10, hw = size * 0.80, hh = size * 0.085, hy = cy - hh / 2;
      const g = bx.createLinearGradient(0, hy, 0, hy + hh);
      g.addColorStop(0, '#b8b8b8'); g.addColorStop(0.18, '#4a4a4a'); // top lip then drop
      g.addColorStop(0.82, '#4a4a4a'); g.addColorStop(1, '#b8b8b8'); // bottom lip
      bx.fillStyle = g; rrect(bx, hx, hy, hw, hh, hh * 0.45); bx.fill();
      // grime: handle interiors grow rougher
      rx.fillStyle = '#a8a8a8'; rrect(rx, hx, hy, hw, hh, hh * 0.45); rx.fill();
      // AO darkens the recess
      const ag = ax.createLinearGradient(0, hy, 0, hy + hh);
      ag.addColorStop(0, 'rgba(70,70,70,0.9)'); ag.addColorStop(0.5, 'rgba(40,40,40,0.95)');
      ag.addColorStop(1, 'rgba(70,70,70,0.9)');
      ax.fillStyle = ag; rrect(ax, hx, hy, hw, hh, hh * 0.45); ax.fill();
    }

    // central perforated intake band (hex dots) between the handles
    const bandY0 = size * 0.40, bandY1 = size * 0.60;
    const step = size / 22, rad = step * 0.3;
    for (let yy = bandY0; yy < bandY1; yy += step) {
      const odd = ((yy - bandY0) / step | 0) % 2;
      for (let xx = size * 0.14; xx < size * 0.86; xx += step) {
        const cx = xx + (odd ? step * 0.5 : 0);
        const g = bx.createRadialGradient(cx, yy, 0, cx, yy, rad);
        g.addColorStop(0, '#3a3a3a'); g.addColorStop(0.7, '#3a3a3a'); g.addColorStop(1, '#a0a0a0');
        bx.fillStyle = g; bx.beginPath(); bx.arc(cx, yy, rad, 0, Math.PI * 2); bx.fill();
        ax.fillStyle = 'rgba(60,60,60,0.55)'; ax.beginPath(); ax.arc(cx, yy, rad, 0, Math.PI * 2); ax.fill();
      }
    }
    rx.fillStyle = 'rgba(150,150,150,0.5)'; rx.fillRect(size * 0.13, bandY0, size * 0.74, bandY1 - bandY0);

    // thin top/bottom seam grooves
    bx.fillStyle = '#3c3c3c';
    bx.fillRect(0, size * 0.05, size, 2); bx.fillRect(0, size * 0.93, size, 2);
    ax.fillStyle = 'rgba(80,80,80,0.7)';
    ax.fillRect(0, size * 0.05, size, 3); ax.fillRect(0, size * 0.93, size, 3);

    return {
      normalMap: normalTexture(heightToNormalCanvas(bump, 1.0)),
      roughnessMap: dataTexture(rough),
      aoMap: dataTexture(ao),
    };
  }

  // Brushed-aluminium maps (3 channels). Grain runs along U (horizontal lines);
  // per-mesh grain direction is rotated via material.anisotropyRotation so a
  // single texture serves rails of any orientation.
  function makeBrushedTex({ size = 512, seed = 31 } = {}) {
    const rng = mulberry32(seed);
    // height: many fine jittered horizontal scratch lines over mid-grey
    const bump = makeCanvas(size);
    const bctx = bump.getContext('2d');
    bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, size, size);
    bctx.lineWidth = 1;
    for (let i = 0; i < 1400; i++) {
      const y = rng() * size;
      const a = 0.03 + rng() * 0.07;
      const dark = rng() < 0.5;
      bctx.strokeStyle = dark ? `rgba(40,40,40,${a})` : `rgba(220,220,220,${a})`;
      bctx.beginPath();
      bctx.moveTo(0, y);
      // slight vertical jitter across the width keeps streaks from looking ruled
      bctx.lineTo(size, y + (rng() - 0.5) * 2.5);
      bctx.stroke();
    }
    // roughness: mid base modulated ALONG the brush direction (this smears the highlight)
    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#6b6b6b'; rctx.fillRect(0, 0, size, size); // ~0.42
    rctx.globalAlpha = 0.5; rctx.drawImage(bump, 0, 0); rctx.globalAlpha = 1;
    // edge wear: a few brighter vertical streaks = polished contact where hands grab
    // (lower roughness reads as buffed metal). Darker value = smoother in a roughnessMap.
    for (let i = 0; i < 7; i++) {
      const x = rng() * size, w = 4 + rng() * 10;
      const g = rctx.createLinearGradient(x - w, 0, x + w, 0);
      g.addColorStop(0, 'rgba(40,40,40,0)');
      g.addColorStop(0.5, `rgba(40,40,40,${0.18 + rng() * 0.12})`);
      g.addColorStop(1, 'rgba(40,40,40,0)');
      rctx.fillStyle = g; rctx.fillRect(x - w, 0, w * 2, size);
    }
    // anisotropy: R=255,G=128 (direction = +tangent), B = strength from streak noise
    const aniso = makeCanvas(size);
    const actx = aniso.getContext('2d');
    actx.fillStyle = 'rgb(255,128,255)'; actx.fillRect(0, 0, size, size);
    actx.globalAlpha = 0.4; actx.drawImage(bump, 0, 0); actx.globalAlpha = 1; // B varies a touch
    // re-pin R/G after the noisy overlay (only B should wander)
    const img = actx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 255; img.data[i + 1] = 128; }
    actx.putImageData(img, 0, 0);
    return {
      roughnessMap: dataTexture(rough),
      normalMap: normalTexture(heightToNormalCanvas(bump, 0.5)),
      anisotropyMap: dataTexture(aniso),
    };
  }

  // Perforated fan-grille: hex lattice of holes. alpha (black = hole, discarded)
  // + height->normal (punched bevel around each hole sells the depth for free).
  function makeGrilleTex({ size = 256, cols = 12 } = {}) {
    const alpha = makeCanvas(size);
    const al = alpha.getContext('2d');
    al.fillStyle = '#ffffff'; al.fillRect(0, 0, size, size); // white = web (kept)
    const bump = makeCanvas(size);
    const bx = bump.getContext('2d');
    bx.fillStyle = '#c8c8c8'; bx.fillRect(0, 0, size, size); // raised web
    const step = size / cols;
    const rad = step * 0.34;
    for (let r = -1; r <= cols; r++) {
      for (let c = -1; c <= cols; c++) {
        const x = (c + 0.5) * step + (r % 2 ? step * 0.5 : 0); // hex offset on odd rows
        const y = (r + 0.5) * step;
        al.fillStyle = '#000000'; // hole -> alphaTest discards
        al.beginPath(); al.arc(x, y, rad, 0, Math.PI * 2); al.fill();
        // bevel: bright ring fading into a dark recessed centre
        const g = bx.createRadialGradient(x, y, rad * 0.4, x, y, rad * 1.25);
        g.addColorStop(0, '#181818'); // recessed
        g.addColorStop(0.78, '#e8e8e8'); // lip
        g.addColorStop(1, '#c8c8c8');
        bx.fillStyle = g;
        bx.beginPath(); bx.arc(x, y, rad * 1.25, 0, Math.PI * 2); bx.fill();
      }
    }
    const at = dataTexture(alpha);
    at.minFilter = THREE.LinearMipmapLinearFilter;
    return {
      alphaMap: at,
      normalMap: normalTexture(heightToNormalCanvas(bump, 1.2)),
    };
  }

  // Small management-screen atlas (2x2 = 4 distinct faces) for the rare lit LCDs
  // dotted across the racks. Faint cool-white/cyan readouts: text rows, a bar
  // graph, a temperature segment. Kept dim (just under the bloom threshold) so the
  // screens GLOW faintly rather than blow out — the "faint glow" brief. Cool tint
  // adds colour-temperature variety against the warm amber LEDs without breaking
  // the single-accent rule (never red).
  function makeScreenAtlas({ size = 256 } = {}) {
    const c = makeCanvas(size);
    const x = c.getContext('2d');
    x.fillStyle = '#05080a'; x.fillRect(0, 0, size, size); // near-black bezel gutter
    const half = size / 2;
    const tile = (ox, oy, draw) => {
      x.save();
      x.beginPath(); x.rect(ox + 4, oy + 4, half - 8, half - 8); x.clip();
      x.fillStyle = '#0a1418'; x.fillRect(ox + 4, oy + 4, half - 8, half - 8); // dim screen
      draw(ox + 4, oy + 4, half - 8, half - 8);
      x.restore();
    };
    // tile 0: text rows (terminal-style)
    tile(0, 0, (px, py, w, h) => {
      x.fillStyle = 'rgba(120,200,210,0.85)';
      for (let i = 0; i < 6; i++) {
        const ww = w * (0.3 + Math.random() * 0.55);
        x.fillRect(px + 6, py + 8 + i * (h / 7), ww, 3);
      }
    });
    // tile 1: bar graph
    tile(half, 0, (px, py, w, h) => {
      const bars = 7, bw = (w - 12) / bars;
      for (let i = 0; i < bars; i++) {
        const bh = h * (0.2 + Math.random() * 0.7);
        x.fillStyle = i === bars - 1 ? 'rgba(214,69,69,0.55)' : 'rgba(110,190,205,0.8)';
        x.fillRect(px + 6 + i * bw, py + h - 6 - bh, bw * 0.7, bh);
      }
    });
    // tile 2: big temperature segment readout
    tile(0, half, (px, py, w, h) => {
      x.fillStyle = 'rgba(150,215,225,0.92)';
      x.font = `bold ${Math.floor(h * 0.42)}px monospace`;
      x.textBaseline = 'middle';
      x.fillText('48°', px + 8, py + h * 0.42);
      x.fillStyle = 'rgba(110,190,205,0.6)';
      x.fillRect(px + 6, py + h * 0.72, w * 0.8, 4);
    });
    // tile 3: grid / status matrix
    tile(half, half, (px, py, w, h) => {
      const n = 5, cell = Math.min(w, h) / (n + 1);
      for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) {
        const lit = Math.random();
        x.fillStyle = lit > 0.85 ? 'rgba(214,69,69,0.5)'
          : lit > 0.4 ? 'rgba(110,200,210,0.75)' : 'rgba(40,70,80,0.6)';
        x.fillRect(px + 6 + cc * cell, py + 6 + r * cell, cell * 0.62, cell * 0.62);
      }
    });
    const t = colorTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  // Printed asset/label strip: a light laminate band with a procedural "barcode"
  // and tick marks that read as text at distance. Matte (paper/laminate), so it
  // never competes with the brushed metal.
  function makeLabelTex({ size = 256 } = {}) {
    const c = makeCanvas(size);
    const x = c.getContext('2d');
    x.fillStyle = '#0b0c0e'; x.fillRect(0, 0, size, size);
    // the laminate sits in the middle band of the strip face
    const y0 = size * 0.30, y1 = size * 0.70;
    x.fillStyle = '#c9ccd0'; x.fillRect(0, y0, size, y1 - y0);
    // barcode block on the left
    let bx = size * 0.04;
    const rng = mulberry32(5);
    while (bx < size * 0.34) {
      const w = 1 + (rng() * 4 | 0);
      if (rng() > 0.4) { x.fillStyle = '#15171a'; x.fillRect(bx, y0 + 3, w, (y1 - y0) - 6); }
      bx += w + 1;
    }
    // tiny asset-number ticks (reads as text)
    x.fillStyle = '#23262a';
    for (let i = 0; i < 18; i++) {
      const tx = size * 0.40 + i * (size * 0.55 / 18);
      x.fillRect(tx, y0 + (y1 - y0) * 0.35, 2 + (rng() * 3 | 0), (y1 - y0) * 0.3);
    }
    return colorTexture(c);
  }

  // Soft radial sprite (white center -> transparent) for haze quads and LED halos.
  function makeGlowTex({ size = 128 } = {}) {
    const c = makeCanvas(size);
    const x = c.getContext('2d');
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return track(t);
  }

  const panelTex = makePanelTex({ size: 512 });
  const orangePeelNormal = makeOrangePeelNormal({ size: 256 });
  orangePeelNormal.repeat.set(4, 8); // keep dimples physically small at rack scale
  const faceplateTex = makeFaceplateTex({ size: 256 });
  const brushTex = makeBrushedTex({ size: 512 });
  const grilleTex = makeGrilleTex({ size: 256, cols: 11 });
  const screenAtlas = makeScreenAtlas({ size: 256 });
  const labelTex = makeLabelTex({ size: 256 });
  const glowTex = makeGlowTex({ size: 128 });

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------
  // Black powder-coated rack frame / chassis (matte, dominant, dark).
  const matChassis = track(new THREE.MeshPhysicalMaterial({
    // powder coat is a pigmented DIELECTRIC under a thin satin coat: low metalness
    color: 0x0c0c0e, metalness: 0.18, roughness: 0.6, ior: 1.5, specularIntensity: 1.0,
    // base normal stays as a faint large-scale panel waviness only
    normalMap: panelTex.normalMap, normalScale: new THREE.Vector2(0.25, 0.25),
    roughnessMap: panelTex.roughnessMap, envMapIntensity: 0.42,
    // the dimple lives in the COATING, not the pigment — independent clearcoat normal
    clearcoat: 1.0, clearcoatRoughness: 0.38, // satin, not gloss
    clearcoatNormalMap: orangePeelNormal,
    clearcoatNormalScale: new THREE.Vector2(0.12, 0.12), // low amplitude flicker only
    // micro-dust retroreflection gives painted metal a faint velvety grazing rim
    sheen: 0.15, sheenColor: new THREE.Color(0x202428), sheenRoughness: 0.9,
  }));
  // Brushed-aluminium rails / sled faces (where light catches). Needs tangents.
  const matRail = track(new THREE.MeshPhysicalMaterial({
    // matte brushed metal: anisotropy removed to kill the moving specular glitter
    color: 0x9a9ea3, metalness: 1.0, roughness: 0.55,
    anisotropy: 0, anisotropyRotation: 0,
    roughnessMap: brushTex.roughnessMap, normalMap: brushTex.normalMap,
    envMapIntensity: 0.3,
  }));
  // Rails oriented along the aisle (Z): rotate grain 90deg so it runs lengthwise.
  const matRailZ = track(matRail.clone());
  matRailZ.anisotropyRotation = Math.PI / 2;
  // Perforated fan grille (alphaTest discard, NOT transparent).
  const matGrille = track(new THREE.MeshPhysicalMaterial({
    color: 0x0e0e10, metalness: 0.9, roughness: 0.5,
    alphaMap: grilleTex.alphaMap, alphaTest: 0.5, // binary holes; cheap, no depth sort
    normalMap: grilleTex.normalMap, side: THREE.FrontSide,
    envMapIntensity: 0.5,
  }));
  // Dark GPU sled body: anodized-aluminium faceplate with baked handles, perforated
  // intake band, seam grooves (normal+roughness+ao). Converts identical flat boxes
  // into surfaces that catch the key light along the handle lips. Needs uv2 for aoMap.
  const matSled = track(new THREE.MeshPhysicalMaterial({
    color: 0x111316, metalness: 0.5, roughness: 0.5,
    normalMap: faceplateTex.normalMap, normalScale: new THREE.Vector2(0.8, 0.8),
    roughnessMap: faceplateTex.roughnessMap,
    aoMap: faceplateTex.aoMap, aoMapIntensity: 1.0,
    clearcoat: 0.15, clearcoatRoughness: 0.45, // injection-molded bezel sheen
    envMapIntensity: 0.5,
  }));
  // Glossy, near-wet floor: picks up the IBL + faint rack/LED reflections (no Reflector).
  const matFloor = track(new THREE.MeshPhysicalMaterial({
    color: 0x070708, metalness: 0.55, roughness: 0.3,
    // a smudged floor reads real; a perfect mirror reads CG. Faint broad roughness
    // drift + a whisper of normal break the uniform highlight into streaks.
    roughnessMap: panelTex.roughnessMap,
    normalMap: panelTex.normalMap, normalScale: new THREE.Vector2(0.12, 0.12),
    // anisotropy elongates the reflected LED columns vertically (down the aisle),
    // exactly as polished concrete smears highlights toward the vanishing point —
    // grounds the racks more convincingly than the isotropic mirror it replaces.
    anisotropy: 0, anisotropyRotation: Math.PI / 2,
    envMapIntensity: 0.4,
  }));

  // -------------------------------------------------------------------------
  // Geometry layout constants for the aisle
  // -------------------------------------------------------------------------
  const RACK_W = 2.4, RACK_H = 5.0, RACK_D = 2.0; // a single rack cabinet
  const AISLE_HALF = 2.2;                          // half-width of the walkway
  const RACKS_PER_SIDE = 9;                         // receding down the aisle
  const RACK_PITCH = 2.7;                           // z-spacing between racks
  const SLEDS_PER_RACK = 9;                         // GPU sleds stacked in a cabinet
  const Z0 = 1.5;                                   // first rack just behind the camera mouth

  // Per-side X for the two rows (racks face the aisle).
  const sideX = AISLE_HALF + RACK_W / 2 + 0.15;

  // -------------------------------------------------------------------------
  // Instanced rack chassis (one draw call) — bevelled cabinets, both rows.
  // -------------------------------------------------------------------------
  const aisle = new THREE.Group();
  scene.add(aisle);

  const chassisGeo = track(new RoundedBoxGeometry(RACK_W, RACK_H, RACK_D, 3, 0.05));
  const rackCount = RACKS_PER_SIDE * 2;
  const chassis = new THREE.InstancedMesh(chassisGeo, matChassis, rackCount);
  chassis.frustumCulled = false; // the aisle fills the frame; avoid all-or-nothing cull pops
  {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        m.makeTranslation(sx, RACK_H / 2, -(Z0 + r * RACK_PITCH));
        chassis.setMatrixAt(i++, m);
      }
    }
    chassis.instanceMatrix.needsUpdate = true;
  }
  // Per-instance wear: nudge roughness +/-0.08 per rack so adjacent cabinets differ
  // subtly and the row stops reading as copy-paste. Pure shader patch, zero texture cost.
  {
    const wearRng = mulberry32(41);
    const aWear = new Float32Array(rackCount);
    for (let i = 0; i < rackCount; i++) aWear[i] = (wearRng() - 0.5) * 0.16;
    chassisGeo.setAttribute('aWear', new THREE.InstancedBufferAttribute(aWear, 1));
  }
  matChassis.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float aWear;\nvarying float vWear;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n vWear = aWear;'
    );
    shader.fragmentShader = 'varying float vWear;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor + vWear, 0.04, 1.0);'
    );
  };
  matChassis.customProgramCacheKey = () => 'dcAisleChassisWear';
  aisle.add(chassis);

  // -------------------------------------------------------------------------
  // Instanced GPU sleds (one draw call) — shallow faces inset on the aisle side.
  // -------------------------------------------------------------------------
  const sledGeo = track(new THREE.BoxGeometry(RACK_W * 0.86, RACK_H / SLEDS_PER_RACK * 0.82, 0.18));
  // aoMap samples the second UV set; BoxGeometry has none, so mirror uv -> uv2.
  sledGeo.setAttribute('uv2', new THREE.BufferAttribute(sledGeo.attributes.uv.array, 2));
  const sledCount = rackCount * SLEDS_PER_RACK;
  const sleds = new THREE.InstancedMesh(sledGeo, matSled, sledCount);
  sleds.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    let i = 0;
    const slot = RACK_H / SLEDS_PER_RACK;
    for (const sx of [-sideX, sideX]) {
      const faceZ = 0; // sleds sit on the aisle-facing front; offset handled per rack below
      const inward = sx < 0 ? 1 : -1; // face toward the aisle centre
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        const rz = -(Z0 + r * RACK_PITCH);
        for (let s = 0; s < SLEDS_PER_RACK; s++) {
          const y = slot * (s + 0.5) + 0.05;
          // push the sled face slightly proud of the cabinet front (toward aisle)
          const x = sx + inward * (RACK_W / 2 - 0.02);
          m.makeTranslation(x, y, rz);
          // rotate so the shallow face points across the aisle (its depth is along X)
          m.multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
          sleds.setMatrixAt(i++, m);
          void faceZ;
        }
      }
    }
    sleds.instanceMatrix.needsUpdate = true;
  }
  // Per-instance faceplate variety: one shared baked map, but per sled we (a) flip
  // the map vertically (swaps which handle is which), (b) shift it a half-tile so
  // the perforation band lands differently, and (c) jitter roughness +/-0.07 for
  // grime variance. Turns ~160 identical fronts into a varied wall for zero extra
  // draw calls and one tiny attribute.
  {
    const fvRng = mulberry32(53);
    const aFaceVar = new Float32Array(sledCount);   // 0..1 flip/shift selector
    const aFaceR = new Float32Array(sledCount);     // roughness nudge
    for (let i = 0; i < sledCount; i++) {
      aFaceVar[i] = fvRng();
      aFaceR[i] = (fvRng() - 0.5) * 0.14;
    }
    sledGeo.setAttribute('aFaceVar', new THREE.InstancedBufferAttribute(aFaceVar, 1));
    sledGeo.setAttribute('aFaceR', new THREE.InstancedBufferAttribute(aFaceR, 1));
  }
  matSled.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float aFaceVar;\nattribute float aFaceR;\n' +
      'varying float vFaceR;\n' + shader.vertexShader;
    // matSled has no base `map`, so its active UV varyings are the per-map ones
    // (normal/roughness/ao all on UV channel 0). Remap each that exists so the
    // flip/shift drives the whole baked faceplate consistently.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
       vFaceR = aFaceR;
       float fFlip = aFaceVar > 0.5 ? 1.0 : 0.0;
       float fShift = step(0.66, aFaceVar) * 0.5;
       #ifdef USE_NORMALMAP
         vNormalMapUv.y = mix(vNormalMapUv.y, 1.0 - vNormalMapUv.y, fFlip);
         vNormalMapUv.x = fract(vNormalMapUv.x + fShift);
       #endif
       #ifdef USE_ROUGHNESSMAP
         vRoughnessMapUv.y = mix(vRoughnessMapUv.y, 1.0 - vRoughnessMapUv.y, fFlip);
         vRoughnessMapUv.x = fract(vRoughnessMapUv.x + fShift);
       #endif
       #ifdef USE_AOMAP
         vAoMapUv.y = mix(vAoMapUv.y, 1.0 - vAoMapUv.y, fFlip);
         vAoMapUv.x = fract(vAoMapUv.x + fShift);
       #endif`
    );
    shader.fragmentShader = 'varying float vFaceR;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor + vFaceR, 0.05, 1.0);'
    );
  };
  matSled.customProgramCacheKey = () => 'dcAisleSledVar';
  aisle.add(sleds);

  // -------------------------------------------------------------------------
  // Instanced perforated fan-grille panels (one draw call) — top vent of each rack.
  // -------------------------------------------------------------------------
  const grilleGeo = track(new THREE.BoxGeometry(RACK_W * 0.8, 0.06, RACK_D * 0.7));
  const grille = new THREE.InstancedMesh(grilleGeo, matGrille, rackCount);
  grille.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        m.makeTranslation(sx, RACK_H - 0.05, -(Z0 + r * RACK_PITCH));
        grille.setMatrixAt(i++, m);
      }
    }
    grille.instanceMatrix.needsUpdate = true;
  }
  aisle.add(grille);

  // -------------------------------------------------------------------------
  // Instanced brushed-metal rails (two draw calls) — vertical posts at rack edges.
  // computeTangents() flips on USE_TANGENT so anisotropic streaks stay STABLE as
  // the camera dollies (the load-bearing fix from finding 1).
  // -------------------------------------------------------------------------
  const railGeo = track(new THREE.BoxGeometry(0.08, RACK_H * 0.98, 0.08));
  railGeo.computeTangents();
  const railCount = rackCount * 2; // front-left & front-right edge of each cabinet
  const rails = new THREE.InstancedMesh(railGeo, matRail, railCount);
  rails.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        const rz = -(Z0 + r * RACK_PITCH);
        for (const ex of [-RACK_W / 2 + 0.06, RACK_W / 2 - 0.06]) {
          m.makeTranslation(sx + ex, RACK_H / 2, rz + RACK_D / 2 - 0.04);
          rails.setMatrixAt(i++, m);
        }
      }
    }
    rails.instanceMatrix.needsUpdate = true;
  }
  aisle.add(rails);

  // Horizontal aisle-running rail (kick plate along the floor on each row).
  const kickGeo = track(new THREE.BoxGeometry(0.1, 0.14, RACK_PITCH * RACKS_PER_SIDE + 1));
  kickGeo.computeTangents();
  const kicks = new THREE.InstancedMesh(kickGeo, matRailZ, 2);
  kicks.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const midZ = -(Z0 + ((RACKS_PER_SIDE - 1) * RACK_PITCH) / 2);
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      const inward = sx < 0 ? 1 : -1;
      m.makeTranslation(sx + inward * (RACK_W / 2 + 0.05), 0.07, midZ);
      kicks.setMatrixAt(i++, m);
    }
    kicks.instanceMatrix.needsUpdate = true;
  }
  aisle.add(kicks);

  // -------------------------------------------------------------------------
  // Greebling: per-sled pull handles, asset-label strips, sparse status screens,
  // and drooping cable bundles at the rack tops. Each family is ONE InstancedMesh
  // (or folds into an existing one), so the whole layer adds ~4 draw calls while
  // killing the "flat box" read. All geometries/materials are track()ed.
  // -------------------------------------------------------------------------

  // Recessed pull handles: a half-loop torus proud of each sled face, two per sled
  // (top + bottom of the faceplate). Brushed aluminium — reuse matRail so no new
  // material. Lies flat against the face (the loop opens toward the aisle).
  const handleGeo = track(new THREE.TorusGeometry(0.052, 0.011, 6, 14, Math.PI));
  const handleCount = sledCount * 2;
  const handles = new THREE.InstancedMesh(handleGeo, matRail, handleCount);
  handles.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const slot = RACK_H / SLEDS_PER_RACK;
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      const inward = sx < 0 ? 1 : -1;
      const x = sx + inward * (RACK_W / 2 + 0.012); // just proud of the sled face
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        const rz = -(Z0 + r * RACK_PITCH);
        for (let s = 0; s < SLEDS_PER_RACK; s++) {
          const y = slot * (s + 0.5) + 0.05;
          for (const off of [-slot * 0.26, slot * 0.26]) {
            // base: lie the torus in the Y-Z plane facing across the aisle (along X)
            m.makeTranslation(x, y + off, rz);
            m.multiply(tmp.makeRotationY(inward > 0 ? Math.PI / 2 : -Math.PI / 2));
            // the half-loop opens downward so it reads as a grab handle
            m.multiply(tmp.makeRotationZ(Math.PI));
            handles.setMatrixAt(i++, m);
          }
        }
      }
    }
    handles.instanceMatrix.needsUpdate = true;
  }
  aisle.add(handles);

  // Asset-label strips: a thin matte laminate band on a subset of sleds (~1 in 3).
  // Printed barcode/ticks read as text at distance. Matte so it never glints.
  const matLabel = track(new THREE.MeshStandardMaterial({
    map: labelTex, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.3,
  }));
  const labelGeo = track(new THREE.BoxGeometry(0.34, 0.05, 0.012));
  const labelPicks = [];
  {
    const lblRng = mulberry32(67);
    for (let s = 0; s < sledCount; s++) if (lblRng() < 0.34) labelPicks.push(s);
  }
  const labels = new THREE.InstancedMesh(labelGeo, matLabel, Math.max(1, labelPicks.length));
  labels.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const slot = RACK_H / SLEDS_PER_RACK;
    const sledsPerSide = RACKS_PER_SIDE * SLEDS_PER_RACK;
    let i = 0;
    for (const idx of labelPicks) {
      const sideNeg = idx < sledsPerSide;        // first half = left row
      const sx = sideNeg ? -sideX : sideX;
      const inward = sx < 0 ? 1 : -1;
      const within = idx % sledsPerSide;
      const r = (within / SLEDS_PER_RACK) | 0;
      const s = within % SLEDS_PER_RACK;
      const rz = -(Z0 + r * RACK_PITCH);
      const y = slot * (s + 0.5) + 0.05 - slot * 0.08;
      const x = sx + inward * (RACK_W / 2 + 0.013);
      m.makeTranslation(x, y, rz + RACK_D * 0.12);
      m.multiply(tmp.makeRotationY(inward > 0 ? Math.PI / 2 : -Math.PI / 2));
      labels.setMatrixAt(i++, m);
    }
    labels.instanceMatrix.needsUpdate = true;
  }
  aisle.add(labels);

  // Status screens: small faintly-lit LCDs on a sparse set of sleds (~1 in 7).
  // Emissive + toneMapped:false but kept JUST under the bloom threshold so they
  // glow softly without blowing out. Per-instance UV picks one of 4 atlas faces.
  const matScreen = track(new THREE.MeshBasicMaterial({
    map: screenAtlas, toneMapped: false, fog: true,
  }));
  const screenGeo = track(new THREE.PlaneGeometry(0.26, 0.16));
  const screenPicks = [];
  {
    const scRng = mulberry32(83);
    for (let s = 0; s < sledCount; s++) if (scRng() < 0.14) screenPicks.push(s);
  }
  const screens = new THREE.InstancedMesh(screenGeo, matScreen, Math.max(1, screenPicks.length));
  screens.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const slot = RACK_H / SLEDS_PER_RACK;
    const sledsPerSide = RACKS_PER_SIDE * SLEDS_PER_RACK;
    const aTile = new Float32Array(Math.max(1, screenPicks.length));
    const tileRng = mulberry32(91);
    let i = 0;
    for (const idx of screenPicks) {
      const sideNeg = idx < sledsPerSide;
      const sx = sideNeg ? -sideX : sideX;
      const inward = sx < 0 ? 1 : -1;
      const within = idx % sledsPerSide;
      const r = (within / SLEDS_PER_RACK) | 0;
      const s = within % SLEDS_PER_RACK;
      const rz = -(Z0 + r * RACK_PITCH);
      const y = slot * (s + 0.5) + 0.05;
      const x = sx + inward * (RACK_W / 2 + 0.016);
      m.makeTranslation(x, y, rz - RACK_D * 0.10);
      m.multiply(tmp.makeRotationY(inward > 0 ? Math.PI / 2 : -Math.PI / 2));
      screens.setMatrixAt(i, m);
      aTile[i] = (tileRng() * 4) | 0; // 0..3
      i++;
    }
    screens.instanceMatrix.needsUpdate = true;
    screenGeo.setAttribute('aTile', new THREE.InstancedBufferAttribute(aTile, 1));
  }
  // Remap the plane UV into one of the 2x2 atlas cells per instance.
  matScreen.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float aTile;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
       #ifdef USE_MAP
         float ti = aTile;
         vec2 cell = vec2(mod(ti, 2.0), floor(ti / 2.0));
         vMapUv = (vMapUv + cell) * 0.5;   // 2x2 atlas
       #endif`
    );
  };
  matScreen.customProgramCacheKey = () => 'dcAisleScreen';
  aisle.add(screens);

  // Cable bundles: drooping catenary loops at the top of each rack — the strongest
  // "lived-in" cue. ONE TubeGeometry built from a fixed quadratic droop, reused
  // across all instances (1 draw call). MeshPhysicalMaterial sheen is the trick
  // that reads as a PVC/braided jacket rather than metal. Per-instance colour:
  // mostly graphite, a little lighter grey, a rare oxide-red strand (the accent).
  const dropCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.55, 0, 0),
    new THREE.Vector3(0, -0.42, 0.06), // droop down + slight bow toward the aisle
    new THREE.Vector3(0.55, 0, 0)
  );
  const cableGeo = track(new THREE.TubeGeometry(dropCurve, 20, 0.016, 7, false));
  const matCable = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0.0, roughness: 0.85,
    sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x222428),
    envMapIntensity: 0.3,
  }));
  const CABLES_PER_RACK = 2;
  const cableCount = rackCount * CABLES_PER_RACK;
  const cables = new THREE.InstancedMesh(cableGeo, matCable, cableCount);
  cables.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const cbRng = mulberry32(71);
    const col = new THREE.Color();
    const GRAPHITE = new THREE.Color(0x0b0c0e);
    const CAT = new THREE.Color(0x2a2d31);
    const ACCENT = new THREE.Color(OXIDE_RED);
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      const inward = sx < 0 ? 1 : -1;
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        const rz = -(Z0 + r * RACK_PITCH);
        for (let cI = 0; cI < CABLES_PER_RACK; cI++) {
          // hang along the top front edge, staggered in Z, scaled to span the bay
          const zJit = (cI - 0.5) * (RACK_D * 0.45);
          const scl = 1.6 + cbRng() * 0.5;
          const drop = 0.85 + cbRng() * 0.6;
          m.makeTranslation(sx + inward * (RACK_W * 0.06), RACK_H - 0.12, rz + zJit);
          m.multiply(tmp.makeRotationY(inward > 0 ? Math.PI / 2 : -Math.PI / 2));
          m.multiply(tmp.makeScale(scl, drop, 1));
          cables.setMatrixAt(i, m);
          const u = cbRng();
          col.copy(u < 0.06 ? ACCENT : u < 0.2 ? CAT : GRAPHITE);
          cables.setColorAt(i, col);
          i++;
        }
      }
    }
    cables.instanceMatrix.needsUpdate = true;
    cables.instanceColor.needsUpdate = true;
  }
  aisle.add(cables);

  // -------------------------------------------------------------------------
  // LEDs (the signature) — one InstancedMesh, per-instance color, GPU blink.
  // Tiny boxes; blink computed in-shader from a uTime uniform + per-instance
  // phase/speed/kind attributes, so JS only updates ONE uniform per frame.
  // -------------------------------------------------------------------------
  const ledRng = mulberry32(99);
  const ledGeo = track(new THREE.BoxGeometry(0.05, 0.05, 0.018));
  // 2 LEDs per sled (a status pair), both rows.
  const LED_COUNT = sledCount * 2;
  const led = new THREE.InstancedMesh(ledGeo, null, LED_COUNT); // material assigned below
  led.frustumCulled = false;
  led.layers.enable(1); // bloom layer (used by the selective fallback if ever needed)

  const ledColor = new THREE.Color();
  const aPhase = new Float32Array(LED_COUNT);
  const aSpeed = new Float32Array(LED_COUNT);
  const aKind = new Float32Array(LED_COUNT);  // 0 steady,1 slow,2 fast,3 heartbeat,4 off
  const aGain = new Float32Array(LED_COUNT);  // per-color emissive gain (perceptual balance)
  // Real racks read green-dominant (link up), with warm-white power, amber status,
  // sparse blue locators and rare oxide-red faults. Red stays the chromatic accent
  // and stays meaningful (fault) rather than decorative.
  const GREEN = new THREE.Color(0x44d17a);
  const WHITE = new THREE.Color(0xf2f4ef);
  const AMBER = new THREE.Color(0xffb454);
  const BLUE = new THREE.Color(0x4aa3ff);
  const RED = new THREE.Color(OXIDE_RED);
  {
    const m = new THREE.Matrix4();
    const slot = RACK_H / SLEDS_PER_RACK;
    let i = 0;
    for (const sx of [-sideX, sideX]) {
      const inward = sx < 0 ? 1 : -1;
      const x = sx + inward * (RACK_W / 2 + 0.005);
      for (let r = 0; r < RACKS_PER_SIDE; r++) {
        const rz = -(Z0 + r * RACK_PITCH);
        for (let s = 0; s < SLEDS_PER_RACK; s++) {
          const y = slot * (s + 0.5) + 0.05;
          for (let p = 0; p < 2; p++) {
            const dz = (p === 0 ? -1 : 1) * (RACK_D * 0.18);
            m.makeTranslation(x, y, rz + dz);
            m.multiply(new THREE.Matrix4().makeRotationY(inward > 0 ? Math.PI / 2 : -Math.PI / 2));
            led.setMatrixAt(i, m);
            // weighted color pick + per-color emissive gain (green/blue read cooler,
            // so they bloom to similar PERCEIVED brightness with a lower multiplier;
            // red needs more to read at the same level after ACES tone mapping).
            const u = ledRng();
            let kindBias;
            if (u < 0.06) { ledColor.copy(RED); aGain[i] = 3.0; kindBias = 'fault'; }
            else if (u < 0.15) { ledColor.copy(BLUE); aGain[i] = 2.0; kindBias = 'locator'; }
            else if (u < 0.33) { ledColor.copy(AMBER); aGain[i] = 2.6; kindBias = 'status'; }
            else if (u < 0.55) { ledColor.copy(WHITE); aGain[i] = 2.4; kindBias = 'power'; }
            else { ledColor.copy(GREEN); aGain[i] = 2.0; kindBias = 'link'; }
            led.setColorAt(i, ledColor);
            aPhase[i] = ledRng() * Math.PI * 2;
            aSpeed[i] = 0.3 + ledRng() * 1.3;
            // behavior matched to semantics: locators slow-pulse, links steady/activity,
            // faults heartbeat, plus a few dead ports (realism through imperfection).
            const k = ledRng();
            if (kindBias === 'locator') aKind[i] = 1;                       // slow 500ms beacon
            else if (kindBias === 'fault') aKind[i] = k < 0.6 ? 3 : 1;      // heartbeat / blink
            else if (kindBias === 'link') aKind[i] = k < 0.55 ? 0 : 2;      // steady or activity
            else aKind[i] = k < 0.5 ? 0 : (k < 0.78 ? 1 : (k < 0.96 ? 2 : 4)); // +rare dead
            i++;
          }
        }
      }
    }
    led.instanceMatrix.needsUpdate = true;
    led.instanceColor.needsUpdate = true; // REQUIRED after setColorAt
  }
  ledGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
  ledGeo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(aSpeed, 1));
  ledGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(aKind, 1));
  ledGeo.setAttribute('aGain', new THREE.InstancedBufferAttribute(aGain, 1));

  // Shared uniforms driven by the RAF.
  const ledUniforms = { uTime: { value: 0 }, uInteract: { value: 0 } };

  // LED material: standard PBR base, but instanceColor is routed into emissive
  // and modulated by an in-shader blink. Push >1 so the bloom threshold catches it.
  const matLed = new THREE.MeshStandardMaterial({
    color: 0x070707, roughness: 0.5, metalness: 0.0,
    emissive: 0xffffff, emissiveIntensity: 1.0,
  });
  matLed.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ledUniforms.uTime;
    shader.uniforms.uInteract = ledUniforms.uInteract;
    shader.vertexShader =
      'attribute float aPhase;\nattribute float aSpeed;\nattribute float aKind;\nattribute float aGain;\n' +
      'varying vec3 vLedCol;\nvarying float vBlink;\nvarying float vGain;\n' +
      'uniform float uTime;\nuniform float uInteract;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vLedCol = instanceColor;
       vGain = aGain;
       float spd = aSpeed * (1.0 + uInteract * 1.0);          // intensify on interaction
       float s = sin(uTime * spd * 6.2831 + aPhase) * 0.5 + 0.5;
       // steady link lights are never perfectly solid: faint activity shimmer
       float steady = 0.82 + 0.06 * sin(uTime * spd * 9.0 + aPhase * 3.0);
       float slow   = mix(0.18, 1.0, s);
       float fast   = step(0.5, fract(uTime * spd * 3.0 + aPhase)); // hard flicker
       // BMC heartbeat: two quick pulses then a gap (period ~1.2s)
       float hb = fract(uTime * 0.83 + aPhase);
       float heartbeat = smoothstep(0.0,0.06,hb)*step(hb,0.10)
                       + smoothstep(0.16,0.22,hb)*step(hb,0.28);
       heartbeat = clamp(heartbeat, 0.12, 1.0);
       vBlink = aKind < 0.5 ? steady
              : (aKind < 1.5 ? slow
              : (aKind < 2.5 ? fast
              : (aKind < 3.5 ? heartbeat : 0.0)));            // 4 = dead/off
       vBlink = mix(vBlink, vBlink * (0.55 + 0.85 * s), uInteract);`
    );
    shader.fragmentShader =
      'varying vec3 vLedCol;\nvarying float vBlink;\nvarying float vGain;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       totalEmissiveRadiance += vLedCol * vBlink * vGain;` // per-color gain crosses bloom
    );
  };
  matLed.customProgramCacheKey = () => 'dcAisleLed';
  led.material = matLed;
  track(matLed);
  aisle.add(led);

  // -------------------------------------------------------------------------
  // Reflective floor + dim "ghost" reflection of the racks.
  // The glossy PBR floor handles sheen/highlights; flipped dim instanced racks
  // (chassis + LEDs) fake the recognizable shapes streaking down — no Reflector.
  // -------------------------------------------------------------------------
  const floorGeo = track(new THREE.PlaneGeometry(60, 80));
  floorGeo.computeTangents(); // anisotropic floor reflection needs a tangent basis
  const floor = new THREE.Mesh(floorGeo, matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -RACK_PITCH * RACKS_PER_SIDE / 2;
  aisle.add(floor);

  // Ghost racks: clone the chassis instances mirrored under the floor, dim + faded.
  const ghostMat = track(new THREE.MeshBasicMaterial({
    color: 0x0c0c0e, transparent: true, opacity: 0.22, depthWrite: false, fog: true,
  }));
  const ghostChassis = new THREE.InstancedMesh(chassisGeo, ghostMat, rackCount);
  ghostChassis.frustumCulled = false;
  // Ghost LEDs (the bright streaks the eye actually reads in a wet floor).
  const ghostLedMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false, fog: true,
  });
  const ghostLed = new THREE.InstancedMesh(ledGeo, ghostLedMat, LED_COUNT);
  ghostLed.frustumCulled = false;
  ghostLed.layers.enable(1);
  track(ghostLedMat);
  {
    // Mirror each chassis/led matrix through y=0 (scale Y by -1).
    const m = new THREE.Matrix4();
    const mirror = new THREE.Matrix4().makeScale(1, -1, 1);
    for (let i = 0; i < rackCount; i++) {
      chassis.getMatrixAt(i, m);
      m.premultiply(mirror);
      ghostChassis.setMatrixAt(i, m);
    }
    ghostChassis.instanceMatrix.needsUpdate = true;
    const c = new THREE.Color();
    for (let i = 0; i < LED_COUNT; i++) {
      led.getMatrixAt(i, m);
      m.premultiply(mirror);
      ghostLed.setMatrixAt(i, m);
      led.getColorAt(i, c);
      ghostLed.setColorAt(i, c);
    }
    ghostLed.instanceMatrix.needsUpdate = true;
    ghostLed.instanceColor.needsUpdate = true;
  }
  // Give ghost LEDs the same blink so reflections pulse with the originals.
  const ghostLedFinalMat = ghostLedMat;
  ghostLedFinalMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ledUniforms.uTime;
    shader.uniforms.uInteract = ledUniforms.uInteract;
    shader.vertexShader =
      'attribute float aPhase;\nattribute float aSpeed;\nattribute float aKind;\n' +
      'varying float vGB;\nuniform float uTime;\nuniform float uInteract;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float spd = aSpeed * (1.0 + uInteract * 1.0);
       float s = sin(uTime * spd * 6.2831 + aPhase) * 0.5 + 0.5;
       float steady = 0.82 + 0.06 * sin(uTime * spd * 9.0 + aPhase * 3.0);
       float slow = mix(0.18, 1.0, s);
       float fast = step(0.5, fract(uTime * spd * 3.0 + aPhase));
       float hb = fract(uTime * 0.83 + aPhase);
       float heartbeat = clamp(smoothstep(0.0,0.06,hb)*step(hb,0.10)
                       + smoothstep(0.16,0.22,hb)*step(hb,0.28), 0.12, 1.0);
       vGB = aKind < 0.5 ? steady
           : (aKind < 1.5 ? slow
           : (aKind < 2.5 ? fast
           : (aKind < 3.5 ? heartbeat : 0.0)));`
    );
    shader.fragmentShader = 'varying float vGB;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       gl_FragColor.rgb *= vGB;
       gl_FragColor.a *= vGB;`
    );
  };
  ghostLedFinalMat.customProgramCacheKey = () => 'dcAisleGhostLed';
  aisle.add(ghostChassis, ghostLed);

  // -------------------------------------------------------------------------
  // Volumetric atmosphere: additive cone shafts under ceiling fixtures +
  // soft camera-facing haze quads down the aisle. depthWrite:false so nothing
  // is occluded; low intensity so they read as light-in-dust, not solid cones.
  // -------------------------------------------------------------------------
  const SHAFT_H = RACK_H + 1.0;
  const shaftMat = track(new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(0xcfd6e0) }, uIntensity: { value: 0.06 },
      uTime: ledUniforms.uTime,        // share the RAF clock — no extra JS per frame
      uHalfH: { value: SHAFT_H * 0.5 },
    },
    vertexShader: `
      varying vec3 vNormalV; varying vec3 vViewV; varying float vY; varying vec3 vWorld;
      void main(){
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vViewV = normalize(-mv.xyz);
        vY = position.y;
        vWorld = (modelMatrix * vec4(position,1.0)).xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uIntensity; uniform float uTime; uniform float uHalfH;
      varying vec3 vNormalV; varying vec3 vViewV; varying float vY; varying vec3 vWorld;
      // cheap 3D value noise (no texture) — animated dust drifting inside the beam
      float hash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float vnoise(vec3 x){ vec3 i=floor(x),f=fract(x); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                       mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                       mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        // sharper rim: most transparent edge-on, so the silhouette reads as a shaft
        float fres = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewV))), 2.3);
        // feather BOTH ends: bright mid-band, fading to nothing at the fixture and floor
        float t = clamp(vY / (2.0 * uHalfH) + 0.5, 0.0, 1.0);
        float feather = smoothstep(0.0, 0.32, t) * (1.0 - smoothstep(0.55, 1.0, t));
        // slow settling dust traffic, never fully extinguishing the beam
        float dust = vnoise(vWorld * 1.5 + vec3(0.0, -uTime * 0.25, 0.0));
        dust = 0.55 + 0.45 * dust;
        float a = fres * feather * dust * uIntensity;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  }));
  const shaftGeo = track(new THREE.ConeGeometry(1.5, SHAFT_H, 22, 1, true));
  const shafts = new THREE.Group();
  // Light columns down the aisle centre, every other rack pitch.
  for (let r = 0; r < RACKS_PER_SIDE; r += 2) {
    const cone = new THREE.Mesh(shaftGeo, shaftMat);
    cone.position.set(0, RACK_H * 0.55, -(Z0 + r * RACK_PITCH));
    shafts.add(cone);
  }
  aisle.add(shafts);

  // Haze slabs: big additive radial quads at staggered depths; parallax with the dolly.
  const hazeMat = track(new THREE.SpriteMaterial({
    map: glowTex, color: 0x10131a, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.05, fog: false,
  }));
  const haze = new THREE.Group();
  for (let r = 0; r < RACKS_PER_SIDE; r += 1) {
    const s = new THREE.Sprite(hazeMat);
    s.scale.set(10, 7, 1);
    s.position.set((r % 2 ? -0.6 : 0.6), RACK_H * 0.4, -(Z0 + r * RACK_PITCH + 0.5));
    haze.add(s);
  }
  aisle.add(haze);

  // Drifting dust motes: ~600 soft additive points scattered through the aisle
  // volume, GPU-animated from the shared uTime so JS stays at one uniform/frame.
  // Near-white and kept BELOW the bloom threshold — they are lit dust catching the
  // shafts, not light sources. The single most cinematic add for a dark hall.
  const MOTE_COUNT = 600;
  const moteGeo = track(new THREE.BufferGeometry());
  {
    const mzRng = mulberry32(127);
    const aisleZSpan = RACK_PITCH * RACKS_PER_SIDE;
    const pos = new Float32Array(MOTE_COUNT * 3);
    const seed = new Float32Array(MOTE_COUNT * 3);
    for (let i = 0; i < MOTE_COUNT; i++) {
      // bias the scatter toward the aisle centre/columns so motes catch the shafts
      pos[i * 3]     = (mzRng() - 0.5) * (AISLE_HALF * 2.2);
      pos[i * 3 + 1] = 0.3 + mzRng() * (RACK_H * 0.95);
      pos[i * 3 + 2] = Z0 - mzRng() * aisleZSpan;
      seed[i * 3]     = mzRng();
      seed[i * 3 + 1] = mzRng();
      seed[i * 3 + 2] = mzRng();
    }
    moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  }
  const moteMat = track(new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    uniforms: {
      uTime: ledUniforms.uTime,
      uColor: { value: new THREE.Color(0xcfd6e0) },
      uTex: { value: glowTex },
    },
    vertexShader: `
      attribute vec3 aSeed; uniform float uTime; varying float vA;
      void main(){
        vec3 p = position;
        // slow incommensurate drift + a gentle downward settle that wraps
        p.x += sin(uTime * 0.07 + aSeed.x * 6.2831) * 0.25;
        p.z += cos(uTime * 0.06 + aSeed.z * 6.2831) * 0.25;
        p.y += sin(uTime * 0.05 + aSeed.y * 6.2831) * 0.15 - mod(uTime * 0.02 + aSeed.y, 1.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.0 + 6.0 * aSeed.x) * (300.0 / -mv.z);
        vA = 0.06 + 0.06 * aSeed.z;        // faint; lit dust, never a glowing point
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform sampler2D uTex; varying float vA;
      void main(){
        float m = texture2D(uTex, gl_PointCoord).a;  // soft radial falloff
        gl_FragColor = vec4(uColor * m * vA, m * vA);
      }`,
  }));
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  aisle.add(motes);

  // -------------------------------------------------------------------------
  // Post: bloom isolates the LEDs by luminance (dark scene + high threshold),
  // OutputPass applies ACES tone mapping + sRGB AFTER bloom (linear-space glow).
  // -------------------------------------------------------------------------
  // GTAO buffers run at a fraction of canvas res: AO is low-frequency and the far
  // racks already dissolve in fog, so half-res contact shadows are invisibly cheap.
  const AO_SCALE = 0.5;
  let composer = null, bloomPass = null, renderPass = null, outputPass = null, gtaoPass = null;
  let gradePass = null, smaaPass = null;
  function buildComposer(w, h) {
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    // Ground-truth AO seats the sleds into the cabinets and darkens the rail/floor
    // crevices that currently read flat. Inserted right after RenderPass so bloom
    // blooms the already-occluded image. radius is WORLD units (racks ~5u tall).
    gtaoPass = new GTAOPass(scene, camera, w * AO_SCALE, h * AO_SCALE);
    gtaoPass.output = GTAOPass.OUTPUT.Default; // beauty * AO (not the debug AO-only view)
    gtaoPass.blendIntensity = 0.85;            // <1 so the already-dark scene isn't crushed to black
    gtaoPass.updateGtaoMaterial({
      radius: 0.4, distanceExponent: 1.0, thickness: 1.0,
      scale: 1.0, samples: 10, distanceFallOff: 1.0, screenSpaceRadius: false,
    });
    gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 10 });
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h),
      0.42,  // strength (eased up on interaction) - dialed down from 0.85
      0.5,   // radius
      0.86); // threshold raised so only the hottest LEDs bloom; metal/screens stay matte
    // Cinematic grade (desat + shadow grain + vignette) AFTER bloom so grain sits
    // over the glow, then SMAA cleans the thin rail/LED edges that the EffectComposer
    // chain would otherwise alias (the renderer's MSAA is bypassed once we render
    // through offscreen targets). SMAA must come last before OutputPass (linear-sRGB).
    gradePass = new ShaderPass(GradeGrainVignetteShader);
    smaaPass = new SMAAPass(w, h);
    outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(gtaoPass);
    composer.addPass(bloomPass);
    composer.addPass(gradePass);
    composer.addPass(smaaPass);
    composer.addPass(outputPass);
  }
  function disposeComposer() {
    if (!composer) return;
    if (gtaoPass) gtaoPass.dispose();
    if (bloomPass) bloomPass.dispose();
    if (gradePass) gradePass.dispose();   // frees its ShaderMaterial + fullscreen quad
    if (smaaPass) smaaPass.dispose();     // frees edges/weights RTs + area/search textures + materials
    if (outputPass) outputPass.dispose(); // frees its RawShaderMaterial + fullscreen quad
    if (composer.renderTarget1) composer.renderTarget1.dispose();
    if (composer.renderTarget2) composer.renderTarget2.dispose();
    composer.dispose();
    composer = bloomPass = renderPass = outputPass = gtaoPass = gradePass = smaaPass = null;
  }

  // -------------------------------------------------------------------------
  // Camera motion state (frame-rate-independent damping; on-demand RAF)
  // -------------------------------------------------------------------------
  const Z_START = 6.5;        // camera near the aisle mouth
  const DOLLY_RANGE = 12.0;   // how far it travels in on scroll
  const STRAFE_X = 0.5, STRAFE_Y = 0.3;     // world-unit parallax (X weighted > Y)
  const MAX_YAW = 0.08, MAX_PITCH = 0.05;   // <5deg sway — keep the hall believable
  const LOOK_DIST = 9;        // forward aim point keeps the vanishing point centred
  const BASE_FOV = 50, ACTIVE_FOV = 46;     // subtle dolly-zoom on engagement

  let px = 0, py = 0;                 // damped pointer
  let pointerTargetX = 0, pointerTargetY = 0;
  let camZ = Z_START, zTarget = Z_START;
  let act = 0, actTarget = 0;         // interaction intensity 0..1 (LED swell, bloom, fov)
  let inputActive = false;
  let lastInputT = -1e9;
  let curFov = BASE_FOV;

  // Click-and-drag FREELOOK: accumulate yaw/pitch from drag deltas over a WIDER
  // range than the hover parallax. CLAMPED (an aisle has no meaningful 360 wrap).
  // On release the velocity carries the look on with eased-out inertia.
  const DRAG_YAW_MAX = 0.6, DRAG_PITCH_MAX = 0.28; // clamp limits (rad)
  const DRAG_YAW_SENS = 0.0022, DRAG_PITCH_SENS = 0.0018; // rad per CSS pixel
  let dragYaw = 0, dragPitch = 0;     // accumulated, clamped freelook angles (rad)
  let dragVelX = 0, dragVelY = 0;     // angular velocity for release inertia (rad/sec)
  let dragging = false, dragPID = -1;
  let lastDragX = 0, lastDragY = 0, lastDragT = 0;
  const clampSym = (v, lim) => (v < -lim ? -lim : v > lim ? lim : v);

  // Apply all eased state to the camera + effects for one frame, then render.
  function applyAndRender(now) {
    // forward aim down the aisle, offset by tiny hover look angles PLUS the
    // wider accumulated click-drag freelook (dragYaw/dragPitch already clamped).
    const lookYaw = -px * MAX_YAW + dragYaw;
    const lookPitch = -py * MAX_PITCH + dragPitch;

    camera.position.x = px * STRAFE_X;
    camera.position.y = 1.55 - py * STRAFE_Y; // eye height ~ standing in the aisle
    camera.position.z = camZ;

    // faint idle breathing (incommensurate freqs) only while recently active
    let driftX = 0, driftY = 0;
    if (now - lastInputT < 5000) {
      const t = now * 0.001;
      driftX = Math.sin(t * 0.13) * 0.04;
      driftY = Math.cos(t * 0.09) * 0.025;
      camera.position.x += driftX;
      camera.position.y += driftY;
    }

    const aim = new THREE.Vector3(
      Math.sin(lookYaw) * LOOK_DIST + driftX * 0.5,
      camera.position.y + Math.sin(lookPitch) * LOOK_DIST,
      camera.position.z - LOOK_DIST
    );
    camera.lookAt(aim);

    // subtle dolly-zoom on engagement
    const fov = BASE_FOV + (ACTIVE_FOV - BASE_FOV) * act;
    if (Math.abs(fov - curFov) > 1e-3) { curFov = fov; camera.fov = fov; camera.updateProjectionMatrix(); }

    // interaction levers: LEDs wake up, bloom & haze swell, fog opens slightly
    ledUniforms.uInteract.value = act;
    if (bloomPass) bloomPass.strength = 0.42 + act * 0.22;
    // animate grain (slow scroll keeps it lively, not strobing) + tighten the vignette
    // a touch on engagement so the eye is pulled to the centred vanishing point.
    if (gradePass) {
      gradePass.uniforms.uTime.value = now * 0.001;
      gradePass.uniforms.uVigDark.value = 1.0 + act * 0.2;
    }
    shaftMat.uniforms.uIntensity.value = 0.06 + act * 0.03;
    scene.fog.density = 0.058 - act * 0.016; // open the aisle as the user engages

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  // Settle test: stop the loop when everything has reached its target AND no
  // input is active AND drift has timed out. Exponential damping asymptotes but
  // never arrives, so we need the epsilon or the loop runs forever.
  function settled(now) {
    const EPS = 1e-3;
    return Math.abs(px - pointerTargetX) < EPS &&
           Math.abs(py - pointerTargetY) < EPS &&
           Math.abs(camZ - zTarget) < 5e-3 &&
           Math.abs(act - actTarget) < EPS &&
           !inputActive &&
           !dragging &&
           dragVelX === 0 && dragVelY === 0 &&
           (now - lastInputT) > 5000;
  }

  let running = false, raf = 0, last = 0;
  let disposed = false; // hard gate: deferred callbacks must not resurrect a torn-down instance

  function tick(now) {
    if (!running || disposed) return;
    const dt = Math.min((now - last) / 1000, 0.05); last = now; // clamp anti-spike
    px = damp(px, pointerTargetX, 6, dt);
    py = damp(py, pointerTargetY, 6, dt);
    camZ = damp(camZ, zTarget, 4, dt);
    act = damp(act, actTarget, 3, dt);
    // Release inertia: coast the freelook on residual velocity, easing to zero.
    if (!dragging && (dragVelX !== 0 || dragVelY !== 0)) {
      dragYaw = clampSym(dragYaw + dragVelX * dt, DRAG_YAW_MAX);
      dragPitch = clampSym(dragPitch + dragVelY * dt, DRAG_PITCH_MAX);
      const decay = Math.exp(-4.5 * dt); // exponential ease-out
      dragVelX *= decay; dragVelY *= decay;
      if (Math.abs(dragVelX) < 1e-3) dragVelX = 0;
      if (Math.abs(dragVelY) < 1e-3) dragVelY = 0;
    }
    ledUniforms.uTime.value = now * 0.001;
    applyAndRender(now);
    if (settled(now)) {
      // snap sub-pixel residue and render one clean final frame
      px = pointerTargetX; py = pointerTargetY; camZ = zTarget; act = actTarget;
      applyAndRender(now);
      running = false; raf = 0; return;
    }
    raf = requestAnimationFrame(tick);
  }

  // Re-arm the loop on any input/resize/restore. Never queue twice.
  function kick() {
    if (reduced || running || disposed) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------
  // Input: cursor parallax over the mount + scroll-progress fallback (touch).
  // -------------------------------------------------------------------------
  function onPointerMove(e) {
    const r = mount.getBoundingClientRect();
    pointerTargetX = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointerTargetY = ((e.clientY - r.top) / r.height) * 2 - 1;
    actTarget = 1;
    // pointermove is a TRANSIENT event: don't latch inputActive (a motionless
    // hover would never fire again and the loop would spin forever). lastInputT
    // + the 5s drift window keep the loop alive while engaged; settled() ends it.
    inputActive = false;
    lastInputT = performance.now();
    kick();
  }
  function onPointerLeave() {
    pointerTargetX = 0; pointerTargetY = 0;
    actTarget = 0;
    inputActive = false;
    lastInputT = performance.now();
    kick();
  }

  // Click-and-drag FREELOOK. Pointer events cover mouse + touch; pointer capture
  // keeps the drag alive even when the cursor leaves the canvas mid-gesture.
  const canvas = renderer.domElement;
  function onPointerDown(e) {
    dragging = true;
    dragPID = e.pointerId;
    dragVelX = 0; dragVelY = 0;       // kill any leftover inertia
    lastDragX = e.clientX; lastDragY = e.clientY;
    lastDragT = performance.now();
    actTarget = 1;
    inputActive = true;               // latch: the loop must run for the whole drag
    lastInputT = lastDragT;
    canvas.style.cursor = 'grabbing';
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
    kick();
  }
  function onPointerDrag(e) {
    if (!dragging || e.pointerId !== dragPID) return;
    const now = performance.now();
    const dx = e.clientX - lastDragX, dy = e.clientY - lastDragY;
    lastDragX = e.clientX; lastDragY = e.clientY;
    // accumulate, clamped (no 360 wrap — an aisle has a meaningful front)
    dragYaw = clampSym(dragYaw - dx * DRAG_YAW_SENS, DRAG_YAW_MAX);
    dragPitch = clampSym(dragPitch - dy * DRAG_PITCH_SENS, DRAG_PITCH_MAX);
    // track angular velocity (rad/sec) for release inertia
    const dtv = Math.max((now - lastDragT) / 1000, 1e-3);
    dragVelX = (-dx * DRAG_YAW_SENS) / dtv;
    dragVelY = (-dy * DRAG_PITCH_SENS) / dtv;
    lastDragT = now;
    actTarget = 1;
    inputActive = true;
    lastInputT = now;
    kick();
  }
  function onPointerUp(e) {
    if (!dragging || (e.pointerId !== dragPID && dragPID !== -1)) return;
    dragging = false;
    inputActive = false;              // unlatch; inertia + drift keep the loop alive
    lastInputT = performance.now();
    canvas.style.cursor = 'grab';
    if (canvas.releasePointerCapture && dragPID !== -1) {
      try { canvas.releasePointerCapture(dragPID); } catch (_) {}
    }
    dragPID = -1;
    kick();
  }

  // Continuous 0..1 progress of the mount through the viewport.
  function scrollProgress() {
    const r = mount.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return clamp01((vh - r.top) / (vh + r.height));
  }
  let scrollPending = false;
  function onScroll() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      if (disposed) return;
      const sp = scrollProgress();
      zTarget = Z_START - sp * DOLLY_RANGE; // dolly INTO the aisle as you scroll past
      // touch fallback: drive a gentle sway + activity off scroll (no cursor)
      pointerTargetX = Math.sin(sp * Math.PI * 2) * 0.4;
      pointerTargetY = Math.cos(sp * Math.PI * 2) * 0.25;
      actTarget = 0.6;
      inputActive = false;
      lastInputT = performance.now();
      kick();
    });
  }

  // Start/stop the scroll loop only while the mount is on-screen.
  let io = null;
  let onScreen = true;

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------
  function resize() {
    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const dpr = renderer.getPixelRatio();
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w * dpr, h * dpr);
    if (gtaoPass) gtaoPass.setSize(w * dpr * AO_SCALE, h * dpr * AO_SCALE);
    // SMAA follows the composer's offscreen-target size (CSS px), NOT dpr-scaled
    // like bloom — its edge/weights RTs are sized to the composer, not device pixels.
    if (smaaPass) smaaPass.setSize(w, h);
  }

  // -------------------------------------------------------------------------
  // Reduced motion: render ONE static, well-composed frame. No listeners, no loop.
  // -------------------------------------------------------------------------
  function renderStaticFrame() {
    if (disposed) return;
    // partway down the aisle, slightly off-axis — leading lines to a centred VP
    px = 0.4; py = 0.1;
    camZ = Z_START - DOLLY_RANGE * 0.35;
    act = 0.35;
    curFov = 48; camera.fov = 48; camera.updateProjectionMatrix();
    ledUniforms.uTime.value = 1.7; // a frozen mid-blink moment with varied LED states
    ledUniforms.uInteract.value = 0.35;
    if (bloomPass) bloomPass.strength = 0.5;
    applyAndRender(performance.now());
  }

  // -------------------------------------------------------------------------
  // Context-loss guard (GPU reset invalidates PMREM env + composer targets)
  // -------------------------------------------------------------------------
  const onLost = e => { e.preventDefault(); running = false; if (raf) cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => {
    const oldEnv = envTex;
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    if (oldEnv) oldEnv.dispose();
    disposeComposer();
    const w = Math.max(1, mount.clientWidth), h = Math.max(1, mount.clientHeight);
    buildComposer(w, h);
    resize();
    if (reduced) renderStaticFrame();
    else if (started) kick();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  // -------------------------------------------------------------------------
  // Build composer + initial size; wire observers/listeners (non-reduced only).
  // -------------------------------------------------------------------------
  buildComposer(1, 1);
  resize();

  const ro = new ResizeObserver(() => {
    resize();
    if (reduced) renderStaticFrame();
    else kick();
  });
  ro.observe(mount);

  if (!reduced) {
    mount.addEventListener('pointermove', onPointerMove);
    mount.addEventListener('pointerleave', onPointerLeave);
    // freelook: grab affordance + suppress touch scrolling/gestures over the canvas
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerDrag);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('scroll', onScroll, { passive: true });
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        onScreen = entries[0].isIntersecting;
        if (onScreen) { onScroll(); } // sync dolly to current scroll position when entering
      }, { threshold: 0 });
      io.observe(mount);
    }
  }

  let started = false;

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------
  return {
    start() {
      started = true;
      resize();
      if (reduced) {
        requestAnimationFrame(() => renderStaticFrame());
        return;
      }
      // sync dolly to current scroll position, then run until settled
      zTarget = Z_START - scrollProgress() * DOLLY_RANGE;
      lastInputT = performance.now();
      kick();
    },
    stop() {
      // pause the RAF but keep the GL context alive
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    dispose() {
      disposed = true;
      this.stop();
      ro.disconnect();
      if (io) io.disconnect();
      mount.removeEventListener('pointermove', onPointerMove);
      mount.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerDrag);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      if (dragPID !== -1 && canvas.releasePointerCapture) {
        try { canvas.releasePointerCapture(dragPID); } catch (_) {}
      }
      window.removeEventListener('scroll', onScroll);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      disposeComposer();
      disposables.forEach(d => d && d.dispose && d.dispose());
      // ghostMat / ghostLedMat / matLed are all tracked in `disposables`; envTex is
      // reassigned on context-restore so it is freed explicitly here.
      if (envTex) envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
