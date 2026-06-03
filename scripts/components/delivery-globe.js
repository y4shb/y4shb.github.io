import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Global Software Delivery Network: a hyper-realistic dark night-Earth that
// ships software/drivers worldwide. A moody PBR globe (dark landmasses, faint
// coastline emissive, sun-masked fresnel atmosphere) carries animated
// great-circle arcs from one oxide-red origin node to pulsing destination
// nodes across the continents. Cursor parallaxes/orbits the globe and
// highlights the nearest destination + its arc; scroll spins it as a touch
// fallback. Self-contained ES module: drives its own camera, gates the RAF on
// demand, and tears everything down in dispose(). All land/sea is procedurally
// generated noise (IP-safe; no real geography or trademarked artwork).
//
// Lifecycle/quality patterns mirror scripts/sections/proj-dcauto.js:
// disposable tracking, PMREM IBL, ACES tone mapping, context-loss rebuild,
// ResizeObserver, DPR cap, reduced-motion single static frame.

const OXIDE_RED = '#d64545';
const GLOBE_R = 2.0;             // globe radius in scene units
const BLOOM_LAYER = 1;          // objects tagged into this layer glow

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);

  // -------------------------------------------------------------------------
  // Renderer
  // -------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0a0a0a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9; // master dark-look dial; low + HDR emissive = cinematic (crushed for filmic blacks)
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  // grab cursor + no native touch-scroll so click-drag spins the globe; only
  // meaningful with input (reduced motion leaves these as cosmetic defaults).
  if (!reduced) {
    renderer.domElement.style.cursor = 'grab';
    renderer.domElement.style.touchAction = 'none';
  }
  mount.appendChild(renderer.domElement);

  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 6.4);

  // -------------------------------------------------------------------------
  // Environment (IBL): faint reflections on the ocean, never used as backdrop.
  // -------------------------------------------------------------------------
  // Low-blur PMREM of a neutral room: this is the SPECULAR reflection source
  // for the metallic ocean (sharp env glints), NOT a diffuse fill. Kept dim via
  // envMapIntensity on the earth so it never lifts the night-side blacks; the
  // sun-glint and terminator come from the directional key, not the IBL.
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  // A single strong directional key creates the day/night terminator -- the
  // cue that sells "planet lit by a distant sun" rather than a lamp. The key is
  // warm (sunlight ~5800K with a touch of atmospheric reddening), pushed hot so
  // the lit hemisphere reads as a real sunlit disc with headroom for ACES
  // roll-off. Ambient + fill stay deliberately low so the dark side crushes to
  // near-black and the city lights own the night -- the core photoreal contrast.
  const SUN_DIR = new THREE.Vector3(0.6, 0.25, 0.75).normalize();
  const key = new THREE.DirectionalLight(0xfff1e0, 3.1);
  key.position.copy(SUN_DIR).multiplyScalar(10);
  // cool sky-fill bounces a whisper of light into the day-side shadows so the
  // lit hemisphere keeps form, NOT into the night side -- it sits opposite-ish
  // but high, mimicking blue-sky ambient over the sunlit half. Kept very low.
  const fill = new THREE.DirectionalLight(0x7e98c0, 0.16);
  fill.position.set(-6, 3, 5);
  // oxide rim grazes the dark limb from behind for a faint warm edge separation
  // (palette accent), too weak to lift the night side into legibility.
  const rim = new THREE.DirectionalLight(0xd64545, 0.55);
  rim.position.set(-4, 5, -9);
  scene.add(key, fill, rim);
  // near-zero cool ambient: enough to keep the night side from pure 0,0,0
  // (which reads as a CGI hole) without washing out the city lights.
  scene.add(new THREE.AmbientLight(0x0b1018, 0.12));

  // Track every disposable for teardown.
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  // -------------------------------------------------------------------------
  // Canvas / texture helpers (match exemplar)
  // -------------------------------------------------------------------------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h || w;
    return c;
  }
  function colorTexture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }
  function dataTexture(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
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
  // Procedural land/sea mask
  // 3D value-noise fBm sampled on the unit sphere (NOT in equirect UV space,
  // which pinches at the poles). Domain-warped so coastlines read as craggy
  // continents, not uniform fractal blobs. The single grayscale mask drives
  // albedo selection, roughness (matte land / smooth specular ocean) and the
  // faint coastline emissive.
  // -------------------------------------------------------------------------
  function hash3(x, y, z) {
    let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
  }
  function valueNoise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
    const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
    const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
    const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
    const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  }
  function fbm3(x, y, z, octaves) {
    let amp = 0.5, freq = 1.0, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * valueNoise3(x * freq, y * freq, z * freq);
      norm += amp; amp *= 0.5; freq *= 2.0;
    }
    return sum / norm;
  }

  // Bake the equirectangular mask once. Returns a Float32 height field plus the
  // grayscale canvas (mask) so we can derive coastlines on the CPU.
  function bakeLandMask(W, H, seed) {
    const off = seed * 13.37;
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      // latitude 0..PI, longitude 0..2PI -> unit sphere point
      const phi = (y / (H - 1)) * Math.PI;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      for (let x = 0; x < W; x++) {
        const theta = (x / W) * Math.PI * 2;
        const px = sinPhi * Math.cos(theta);
        const py = cosPhi;
        const pz = sinPhi * Math.sin(theta);
        const s = 2.1; // continent scale
        // domain warp with a low-frequency offset for organic coasts
        const wx = fbm3((px + off) * 1.3, py * 1.3, pz * 1.3, 3) - 0.5;
        const wy = fbm3((px - off) * 1.3, (py + 5.2) * 1.3, pz * 1.3, 3) - 0.5;
        let n = fbm3(px * s + wx * 0.9, py * s + wy * 0.9, pz * s, 5);
        // bias coverage toward ~32% land, slightly less land near poles (ice/sea)
        const polar = Math.abs(cosPhi);
        n -= polar * 0.08;
        data[y * W + x] = n;
      }
    }
    return data;
  }

  // Build the three globe maps (albedo, roughness, emissive coastline) from the
  // baked height field. Threshold = sea level; smoothstep gives anti-aliased
  // coasts; the gradient magnitude of the mask becomes the thin coastline glow.
  function makeGlobeTextures({ W = 1024, H = 512, seed = 7, sea = 0.5 } = {}) {
    const field = bakeLandMask(W, H, seed);
    const alb = makeCanvas(W, H), aImg = alb.getContext('2d').createImageData(W, H);
    const rgh = makeCanvas(W, H), rImg = rgh.getContext('2d').createImageData(W, H);
    const emi = makeCanvas(W, H), eImg = emi.getContext('2d').createImageData(W, H);
    const ht = makeCanvas(W, H), hImg = ht.getContext('2d').createImageData(W, H);
    const mtl = makeCanvas(W, H), mImg = mtl.getContext('2d').createImageData(W, H);

    const rng = mulberry32(seed * 977 + 5);
    const at = (x, y) => field[((y + H) % H) * W + ((x + W) % W)];
    const land01 = v => clamp((v - sea) / 0.045, 0, 1); // soft 0..1 landness

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = field[y * W + x];
        const land = land01(v);

        // --- albedo: cool near-black ocean, slightly warmer near-black land.
        // Continents read by SHADING, never by saturated color.
        const seaR = 6, seaG = 11, seaB = 16;       // #060b10
        const lndR = 24, lndG = 28, lndB = 32;      // #181c20
        // micro terrain mottle on land so it isn't a flat plate
        const mott = land > 0 ? (valueNoise3(x * 0.07, y * 0.07, 3.3) - 0.5) * 10 : 0;
        aImg.data[i]     = lerp(seaR, lndR + mott, land);
        aImg.data[i + 1] = lerp(seaG, lndG + mott, land);
        aImg.data[i + 2] = lerp(seaB, lndB + mott, land);
        aImg.data[i + 3] = 255;

        // --- roughness: smooth ocean (tight specular glint), matte land.
        // ocean pulled lower (~0.10) for a crisp mirror sun-glint; land matte.
        const oceanRgh = 24 + (valueNoise3(x * 0.05, y * 0.05, 9.1) - 0.5) * 12;
        const landRgh = 225;
        const rv = lerp(oceanRgh, landRgh, land);
        rImg.data[i] = rImg.data[i + 1] = rImg.data[i + 2] = rv; rImg.data[i + 3] = 255;

        // --- metalness: ocean slightly metallic so the env/sun reflection reads
        // as a sharp specular sheet (water), land fully dielectric.
        const mv = lerp(64, 0, land); // ocean ~0.25 metal, land 0.0
        mImg.data[i] = mImg.data[i + 1] = mImg.data[i + 2] = mv; mImg.data[i + 3] = 255;

        // --- height: land lifts above sea; add a fine high-freq octave on land
        // so the baked normal carries crisp micro-relief (mountains/coast detail)
        // without raising normalScale (which would emboss the silhouette).
        const detail = land > 0 ? (valueNoise3(x * 0.42, y * 0.42, 17.0) - 0.5) * 26 * land : 0;
        const hv = clamp(40 + land * 150 + (land > 0 ? mott * 2 : 0) + detail, 0, 255);
        hImg.data[i] = hImg.data[i + 1] = hImg.data[i + 2] = hv; hImg.data[i + 3] = 255;
      }
    }

    // --- night-side emissive: city lights (warm sodium-vapor sparks clustered
    // by a coarse "population" fBm) PLUS a faint coastline thread. A shader night
    // mask (onBeforeCompile, below) hides all of this on the lit hemisphere so
    // the lights only appear on the dark side -- the key real-night-Earth cue.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const land = land01(field[y * W + x]);

        // coastline thread: gradient magnitude of landness, thin + faint.
        const c = land01(at(x, y));
        const gx = land01(at(x + 1, y)) - land01(at(x - 1, y));
        const gy = land01(at(x, y + 1)) - land01(at(x, y - 1));
        let edge = Math.min(1, Math.hypot(gx, gy) * 2.2);
        edge *= 1 - Math.abs(c - 0.5) * 2;
        edge = clamp(edge, 0, 1) * (0.6 + rng() * 0.4);

        // population density: coarse fBm gated by land -> lights cluster into
        // "cities" instead of an even speckle. Squared to sharpen the cores.
        const pop = land * Math.pow(valueNoise3(x * 0.06 + 50, y * 0.06, 1.7), 2.0);
        // sparse bright points: hash thresholded by pop -> discrete settlements.
        const spark = hash3(x * 1.7, y * 1.7, 9.9);
        const city = (pop > 0.10 && spark > (1.0 - pop * 0.55)) ? (0.5 + spark * 0.5) : 0;

        // warm sodium tint for cities (~#ffc76b); cool-neutral for the coast.
        const r = city * 255 * 1.00 + edge * 60;
        const g = city * 255 * 0.78 + edge * 50;
        const b = city * 255 * 0.42 + edge * 46;
        eImg.data[i]     = clamp(r, 0, 255);
        eImg.data[i + 1] = clamp(g, 0, 255);
        eImg.data[i + 2] = clamp(b, 0, 255);
        eImg.data[i + 3] = 255;
      }
    }

    alb.getContext('2d').putImageData(aImg, 0, 0);
    rgh.getContext('2d').putImageData(rImg, 0, 0);
    emi.getContext('2d').putImageData(eImg, 0, 0);
    ht.getContext('2d').putImageData(hImg, 0, 0);
    mtl.getContext('2d').putImageData(mImg, 0, 0);

    return {
      map: colorTexture(alb),
      roughnessMap: dataTexture(rgh),
      metalnessMap: dataTexture(mtl),
      emissiveMap: colorTexture(emi),
      // higher bake strength (finer micro-relief) then attenuated by normalScale
      normalMap: dataTexture(heightToNormal(ht, 1.4)),
    };
  }

  // Sobel height -> tangent-space normal (kept low strength; over-bumped land
  // looks like a relief globe, not a planet).
  function heightToNormal(srcCanvas, strength) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const src = sctx.getImageData(0, 0, w, h).data;
    const out = makeCanvas(w, h);
    const octx = out.getContext('2d');
    const dst = octx.createImageData(w, h);
    const lum = (x, y) => {
      const xi = (x + w) % w, yi = clamp(y, 0, h - 1);
      return src[(yi * w + xi) * 4] / 255;
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
        const i = (y * w + x) * 4;
        dst.data[i] = (nx / len * 0.5 + 0.5) * 255;
        dst.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
        dst.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
        dst.data[i + 3] = 255;
      }
    }
    octx.putImageData(dst, 0, 0);
    return out;
  }

  // Soft procedural cloud coverage baked on the sphere (same anti-pole-pinch
  // fBm as the land mask). Grayscale -> used as alphaMap so dense tops are
  // opaque and gaps are clear (broken cloud, not an overcast veil).
  function makeCloudTexture(W, H, seed) {
    const c = makeCanvas(W, H);
    const img = c.getContext('2d').createImageData(W, H);
    const off = seed * 7.13;
    for (let y = 0; y < H; y++) {
      const phi = (y / (H - 1)) * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
      for (let x = 0; x < W; x++) {
        const th = (x / W) * Math.PI * 2;
        const px = sp * Math.cos(th), py = cp, pz = sp * Math.sin(th);
        let n = fbm3((px + off) * 2.6, py * 2.6, pz * 2.6, 5);
        n = clamp((n - 0.52) / 0.30, 0, 1); // threshold -> broken coverage
        n = n * n * (3 - 2 * n);            // smoothstep soft edges
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = n * 255;
        img.data[i + 3] = 255;
      }
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return dataTexture(c);
  }

  // Radial-gradient sprite texture (shared by all glow halos).
  function makeGlowSprite(size, inner, outer) {
    const c = makeCanvas(size, size);
    const x = c.getContext('2d');
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1.0, 'rgba(214,69,69,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    return colorTexture(c);
  }

  // -------------------------------------------------------------------------
  // Globe: dark PBR sphere -- continents emerge from shading + specular ocean.
  // -------------------------------------------------------------------------
  const globe = new THREE.Group();       // earth + atmosphere + nodes + arcs
  scene.add(globe);

  // Shared elapsed-time uniform driving the starfield twinkle (advanced in
  // step() and set once in renderStaticFrame()). Declared before the nodes'
  // uTime so the stars can be built up here next to the scene.
  const uTimeStars = { value: 0 };

  // -------------------------------------------------------------------------
  // Starfield backdrop: ONE Points object on a large sphere shell, parented to
  // the SCENE (not the globe) so the cosmos stays fixed while the planet spins.
  // Soft round sprites via gl_PointCoord; per-star GPU twinkle in the vertex
  // shader (no CPU cost); size^2 distribution -> a few bright stars, many faint.
  // Neutral cool-white only (never oxide -- red stays exclusive to the network).
  // -------------------------------------------------------------------------
  const STAR_N = 720;
  const starGeo = track(new THREE.BufferGeometry());
  {
    const pos = new Float32Array(STAR_N * 3);
    const rnd = new Float32Array(STAR_N);   // twinkle phase
    const siz = new Float32Array(STAR_N);   // per-star base size
    const srng = mulberry32(99);
    for (let i = 0; i < STAR_N; i++) {
      const u = srng() * 2 - 1, t = srng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const R = 45 + srng() * 12;            // outside the globe, inside far=100
      pos[i * 3] = Math.cos(t) * r * R;
      pos[i * 3 + 1] = u * R;
      pos[i * 3 + 2] = Math.sin(t) * r * R;
      rnd[i] = srng() * 6.2831;
      siz[i] = 0.6 + srng() * srng() * 2.2;  // squared -> few big, many faint
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    starGeo.setAttribute('aRnd', new THREE.Float32BufferAttribute(rnd, 1));
    starGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(siz, 1));
  }
  const starMat = track(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: uTimeStars,
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      uniform float uPixelRatio;
      attribute float aRnd;
      attribute float aSize;
      varying float vTw;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vTw = 0.55 + 0.45 * sin(uTime * 1.3 + aRnd);     // twinkle 0.1..1.0
        gl_PointSize = aSize * uPixelRatio * (180.0 / -mv.z);
      }
    `,
    fragmentShader: /* glsl */`
      varying float vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);             // soft round disk
        a = pow(a, 1.8) * vTw;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.78, 0.82, 0.92) * a, a); // neutral cool-white
      }
    `,
  }));
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);

  const gtex = makeGlobeTextures({ W: 2048, H: 1024, seed: 7, sea: 0.5 });
  const earthGeo = track(new THREE.SphereGeometry(GLOBE_R, 96, 64));
  const earthMat = track(new THREE.MeshPhysicalMaterial({
    map: gtex.map,
    roughnessMap: gtex.roughnessMap,
    metalnessMap: gtex.metalnessMap,
    normalMap: gtex.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    emissiveMap: gtex.emissiveMap,
    emissive: new THREE.Color(0xffffff),
    // raised: the emissive is now masked to the night side (onBeforeCompile), so
    // city lights can be bright on the dark hemisphere yet vanish in daylight.
    emissiveIntensity: 1.6,
    color: 0xffffff,
    metalness: 1.0,                      // fully driven by metalnessMap (ocean only)
    roughness: 1.0,                      // modulated per-texel by roughnessMap
    clearcoat: 0.35, clearcoatRoughness: 0.28, // tighter wet glint on the ocean limb
    sheen: 0.12, sheenRoughness: 0.9, sheenColor: new THREE.Color(0x121820),
    envMapIntensity: 0.7,
  }));
  // Night-side city lights + ocean sun-glint. We compute a world-space normal and
  // compare against the constant world-space SUN_DIR: emissive is killed on the
  // lit hemisphere, and a tight specular glint is added on low-roughness ocean
  // facing the sun. (geometryNormal in the meshphysical chunk is view-space, so
  // we carry our own world normal + view dir to avoid a mixed-space bug.)
  earthMat.onBeforeCompile = shader => {
    shader.uniforms.uSunDir = { value: SUN_DIR.clone() };
    shader.uniforms.uAtmo = { value: new THREE.Color(0x3a4654) };
    shader.uniforms.uAtmoWarm = { value: new THREE.Color(OXIDE_RED) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldNrm;\nvarying vec3 vWorldView;')
      .replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n' +
        '  vWorldNrm = normalize(mat3(modelMatrix) * objectNormal);\n' +
        '  vWorldView = normalize(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uAtmo;\nuniform vec3 uAtmoWarm;\nvarying vec3 vWorldNrm;\nvarying vec3 vWorldView;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' +
        '  float _sun = dot(normalize(vWorldNrm), uSunDir);\n' +
        // night mask centered just past the geometric terminator (_sun=0) so the
        // city lights finish ramping on exactly where the diffuse surface has
        // already fallen dark -- no double-lit band, no premature glow on dusk.
        '  float _night = 1.0 - smoothstep(-0.12, 0.04, _sun);\n' +
        '  totalEmissiveRadiance *= _night;')
      .replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n' +
        '  vec3 _R = reflect(-uSunDir, normalize(vWorldNrm));\n' +
        '  float _glint = pow(max(dot(_R, normalize(vWorldView)), 0.0), 240.0);\n' +
        '  float _ocean = 1.0 - clamp(roughnessFactor, 0.0, 1.0);\n' +
        '  float _day = smoothstep(-0.02, 0.18, _sun);\n' +
        '  reflectedLight.directSpecular += vec3(1.0, 0.96, 0.88) * _glint * _ocean * _day * 0.9;\n' +
        // terminator reddening across the DISC (not just the limb): where the sun
        // grazes the surface at a low angle (_sun near 0 on the lit side), the
        // diffuse light warms toward sunset oxide -- the long-path-scatter cue
        // that makes the day/night boundary read as a real sunrise/sunset line.
        '  float _term = smoothstep(0.0, 0.30, _sun) * (1.0 - smoothstep(0.30, 0.62, _sun));\n' +
        '  reflectedLight.directDiffuse *= mix(vec3(1.0), vec3(1.18, 0.86, 0.74), _term * 0.6);')
      // surface-side atmosphere: brighten the planet's own lit silhouette + lay
      // the same oxide sunset thread on the surface limb so the shell glow and
      // surface tint fuse into ONE continuous atmosphere (every quality
      // reference does atmosphere in two places, not just the shell).
      .replace('#include <tonemapping_fragment>',
        '  float _aFres = pow(clamp(1.0 - dot(normalize(vWorldNrm), normalize(vWorldView)), 0.0, 1.0), 2.2);\n' +
        '  float _aDay = 1.0 / (1.0 + exp(-14.0 * (_sun + 0.05)));\n' +
        '  float _aBand = exp(-pow((_sun + 0.05) * 3.2, 2.0));\n' +
        '  vec3 _aCol = mix(uAtmo, uAtmoWarm, _aBand * 0.4);\n' +
        '  gl_FragColor.rgb += _aCol * _aFres * _aDay * 0.18;\n' +
        '#include <tonemapping_fragment>');
  };
  earthMat.needsUpdate = true;
  const earth = new THREE.Mesh(earthGeo, earthMat);
  globe.add(earth);

  // -------------------------------------------------------------------------
  // Cloud shell: a second translucent sphere just above the surface, lit by the
  // same key (so it auto-darkens on the night side) and drifting slightly faster
  // than the globe in step(). Parented to globe so it inherits drag/orbit.
  // -------------------------------------------------------------------------
  const cloudGeo = track(new THREE.SphereGeometry(GLOBE_R * 1.015, 96, 64));
  const cloudTex = makeCloudTexture(1024, 512, 11);
  const cloudMat = track(new THREE.MeshStandardMaterial({
    color: 0xc4ccd4,             // neutral cool-grey, NOT pure white (won't bloom)
    alphaMap: cloudTex,
    transparent: true,
    depthWrite: false,
    roughness: 1.0, metalness: 0.0,
    opacity: 0.62,               // global dimmer atop the alphaMap coverage
  }));
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  globe.add(clouds);

  // -------------------------------------------------------------------------
  // Atmosphere: BackSide additive fresnel shell. Sun-masked so the rim fades on
  // the dark side (an evenly-glowing halo instantly reads as fake). Near-neutral
  // cool color with a whisper of oxide -- palette-compliant, not a blue planet.
  // -------------------------------------------------------------------------
  // A reusable atmosphere shell shader factory. Two stacked BackSide additive
  // shells -- a broad outer haze + a razor-thin inner limb thread -- sell the
  // "viewed from orbit" look. Both share: a scale/bias fresnel (tunable rim
  // start vs ramp), a SIGMOID terminator (sharp day/night cutoff that actually
  // DIES on the night side instead of fading evenly -- the #1 fake-halo tell),
  // a Gaussian warm-oxide sunset band right at the terminator, a faint forward-
  // scatter brightening toward the sun, and a whisper of night-side lift so the
  // dark limb never crushes to a CGI-black silhouette.
  function makeAtmoMaterial(opts) {
    return track(new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x3a4654) },       // cool slate base
        uWarm: { value: new THREE.Color(0x6a7686) },        // faint cool day bias
        uSunset: { value: new THREE.Color(OXIDE_RED) },     // oxide terminator band
        uSunDir: { value: SUN_DIR.clone() },
        uFresnelBias: { value: opts.bias },
        uFresnelScale: { value: opts.scale },
        uFresnelPow: { value: opts.pow },
        uTermSharp: { value: 14.0 },     // sigmoid steepness (10..22)
        uTermBias: { value: 0.05 },      // nudges glow a hair onto the night side
        uDayInt: { value: opts.dayInt }, // lit-limb intensity
        uNightLift: { value: opts.nightLift },
        uBand: { value: opts.band },     // warm sunset band weight
      },
      vertexShader: /* glsl */`
        varying vec3 vNormalW;
        varying vec3 vEye;
        void main() {
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vEye = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vNormalW;
        varying vec3 vEye;
        uniform vec3 uColor, uWarm, uSunset, uSunDir;
        uniform float uFresnelBias, uFresnelScale, uFresnelPow;
        uniform float uTermSharp, uTermBias, uDayInt, uNightLift, uBand;
        void main() {
          vec3 n = normalize(vNormalW);
          // scale/bias fresnel: controllable rim start (bias) + ramp (pow)
          float fres = uFresnelBias + uFresnelScale *
            pow(clamp(1.0 - abs(dot(normalize(vEye), n)), 0.0, 1.0), uFresnelPow);
          float s = dot(n, uSunDir);
          // sigmoid terminator: sharp, physical day/night edge
          float day = 1.0 / (1.0 + exp(-uTermSharp * (s + uTermBias)));
          // Gaussian sunset band peaks exactly AT the terminator, fades fast
          float band = exp(-pow((s + uTermBias) * 3.2, 2.0));
          // forward-scatter: limb facing the sun glows a touch hotter (Mie-ish)
          float fwd = pow(clamp(s, 0.0, 1.0), 1.5);
          vec3 dayCol = mix(uColor, uColor + uWarm * 0.30, fwd);
          vec3 col = mix(dayCol, uSunset, band * uBand);
          float lit = day * uDayInt + (1.0 - day) * uNightLift;
          float a = fres * lit;
          gl_FragColor = vec4(col * fres * lit, a);
        }
      `,
    }));
  }

  // Outer haze: broad, soft, low power.
  const atmoGeo = track(new THREE.SphereGeometry(GLOBE_R * 1.16, 64, 48));
  const atmoMat = makeAtmoMaterial({ bias: 0.05, scale: 1.0, pow: 3.6, dayInt: 0.85, nightLift: 0.10, band: 0.45 });
  const atmo = new THREE.Mesh(atmoGeo, atmoMat);
  atmo.layers.enable(BLOOM_LAYER); // the rim feeds bloom for a soft scatter
  globe.add(atmo);

  // Inner thread: a tight bright line hugging the silhouette (high power, low
  // scale, very close to the surface). Layered with the haze this is what reads
  // as a real atmospheric limb from space rather than a soft glow blob.
  const atmoThreadGeo = track(new THREE.SphereGeometry(GLOBE_R * 1.028, 64, 48));
  const atmoThreadMat = makeAtmoMaterial({ bias: 0.0, scale: 0.6, pow: 7.0, dayInt: 0.9, nightLift: 0.06, band: 0.5 });
  const atmoThread = new THREE.Mesh(atmoThreadGeo, atmoThreadMat);
  atmoThread.layers.enable(BLOOM_LAYER);
  globe.add(atmoThread);

  // -------------------------------------------------------------------------
  // Geo helpers: lat/lng -> Cartesian (three-globe convention) + great-circle.
  // -------------------------------------------------------------------------
  function latLngToVec3(lat, lng, relAlt = 0) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (90 - lng) * Math.PI / 180;
    const r = GLOBE_R * (1 + relAlt);
    const sp = Math.sin(phi);
    return new THREE.Vector3(r * sp * Math.cos(theta), r * Math.cos(phi), r * sp * Math.sin(theta));
  }
  // slerp between two UNIT vectors (great-circle interpolation)
  function slerpVec(a, b, t) {
    const ang = a.angleTo(b);
    if (ang < 1e-5) return a.clone();
    const s = Math.sin(ang);
    return a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s)
      .add(b.clone().multiplyScalar(Math.sin(t * ang) / s));
  }
  // Lifted cubic-bezier arc; peak altitude auto-scales with great-arc distance
  // so long routes rise higher and never clip the globe (three-globe's model).
  function makeArcCurve(a, b, altScale = 1) {
    const ua = a.clone().normalize(), ub = b.clone().normalize();
    const dist = ua.angleTo(ub);                  // radians 0..PI
    const alt = dist / 2 * 0.55 * altScale;       // peak altitude (radius units)
    const lift = t => 1 + Math.sin(t * Math.PI) * alt;
    const m1 = slerpVec(ua, ub, 0.25).multiplyScalar(GLOBE_R * lift(0.25));
    const m2 = slerpVec(ua, ub, 0.75).multiplyScalar(GLOBE_R * lift(0.75));
    return new THREE.CubicBezierCurve3(a.clone(), m1, m2, b.clone());
  }

  // Generic, fictional delivery endpoints spread across the procedural
  // continents (lat/lng are arbitrary, not tied to the generated land -- they
  // just spread points over the sphere). Origin is the anchor.
  const ORIGIN = { lat: 33, lng: -117 };
  const DESTS = [
    { lat: 52, lng: 13 }, { lat: 35, lng: 139 }, { lat: -33, lng: 151 },
    { lat: 1, lng: 104 }, { lat: 19, lng: 73 }, { lat: -23, lng: -46 },
    { lat: 55, lng: 37 }, { lat: 40, lng: -3 }, { lat: 25, lng: 55 },
    { lat: 31, lng: 121 }, { lat: -26, lng: 28 }, { lat: 45, lng: -75 },
    { lat: 1, lng: -78 }, { lat: 60, lng: 24 }, { lat: -34, lng: -58 },
    { lat: 14, lng: 100 }, { lat: 6, lng: 3 }, { lat: 37, lng: 127 },
  ];
  // Stable per-arc RNG: desynchronized dash offsets + altitude jitter so the
  // routes layer at different heights and packets never march in lockstep (a
  // synchronized network reads fake). Seeded so it's deterministic per load.
  const arcRng = mulberry32(4242);
  const arcOffsets = DESTS.map(() => arcRng());           // 0..1 dash stagger
  const arcAltJitter = DESTS.map(() => 0.9 + arcRng() * 0.2); // depth separation

  // -------------------------------------------------------------------------
  // Destination nodes: ONE InstancedMesh (1 draw call). Per-instance phase in a
  // buffer attribute drives an independent emissive pulse via onBeforeCompile
  // (no per-instance shaders, no matrix churn -> raycast geometry stays valid).
  // -------------------------------------------------------------------------
  const uTime = { value: 0 };
  const uHover = { value: -1 };          // hovered instance id, or -1
  const nodeGeo = track(new THREE.SphereGeometry(0.035, 12, 10));
  const nodeMat = track(new THREE.MeshStandardMaterial({
    color: 0x140707,
    emissive: new THREE.Color(OXIDE_RED),
    emissiveIntensity: 2.2,              // HDR-bright so it clears the bloom threshold
    roughness: 0.4, metalness: 0.0,
  }));
  const phases = new Float32Array(DESTS.length);
  for (let i = 0; i < DESTS.length; i++) phases[i] = Math.random() * Math.PI * 2;
  nodeGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  nodeGeo.setAttribute('aId', new THREE.InstancedBufferAttribute(
    Float32Array.from(DESTS, (_, i) => i), 1));

  nodeMat.onBeforeCompile = shader => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uHover = uHover;
    shader.vertexShader = 'attribute float aPhase;\nattribute float aId;\n' +
      'varying float vPhase;\nvarying float vId;\n' +
      shader.vertexShader.replace('void main() {', 'void main() {\n  vPhase = aPhase;\n  vId = aId;');
    shader.fragmentShader = 'uniform float uTime;\nuniform float uHover;\n' +
      'varying float vPhase;\nvarying float vId;\n' +
      shader.fragmentShader.replace(
        'vec3 totalEmissiveRadiance = emissive;',
        'float pulse = 0.55 + 0.45 * sin(uTime * 2.2 + vPhase);\n' +
        '  float hot = abs(vId - uHover) < 0.5 ? 2.1 : 1.0;\n' +
        '  vec3 totalEmissiveRadiance = emissive * pulse * hot;');
  };

  const nodeMesh = new THREE.InstancedMesh(nodeGeo, nodeMat, DESTS.length);
  nodeMesh.layers.enable(BLOOM_LAYER);
  {
    const m = new THREE.Matrix4();
    DESTS.forEach((d, i) => {
      m.makeTranslation(...latLngToVec3(d.lat, d.lng, 0.005).toArray());
      nodeMesh.setMatrixAt(i, m);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    nodeMesh.computeBoundingSphere(); // raycast picking needs this
  }
  globe.add(nodeMesh);

  // Destination glow halos: additive sprites, one per node, cheap soft bloom.
  const haloTex = makeGlowSprite(64, 'rgba(214,69,69,0.9)', 'rgba(214,69,69,0.25)');
  const haloMat = track(new THREE.SpriteMaterial({
    map: haloTex, color: 0xffffff, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, depthTest: true, opacity: 0.7,
  }));
  const halos = [];
  DESTS.forEach((d, i) => {
    // clone the material per halo so each can breathe its own opacity (the
    // shared texture is reused, so this is cheap; clones tracked for disposal)
    const m = track(haloMat.clone());
    const s = new THREE.Sprite(m);
    s.position.copy(latLngToVec3(d.lat, d.lng, 0.006));
    s.scale.setScalar(0.22);
    s.layers.enable(BLOOM_LAYER);
    globe.add(s);
    halos.push({ sprite: s, phase: phases[i] });
  });

  // -------------------------------------------------------------------------
  // Origin node: the brighter oxide-red anchor (its own mesh + bigger halo).
  // -------------------------------------------------------------------------
  const originPos = latLngToVec3(ORIGIN.lat, ORIGIN.lng, 0.006);
  const originGeo = track(new THREE.SphereGeometry(0.055, 16, 12));
  const originMat = track(new THREE.MeshStandardMaterial({
    color: 0x1a0808, emissive: new THREE.Color(OXIDE_RED), emissiveIntensity: 3.2,
    roughness: 0.35, metalness: 0.0,
  }));
  const originMesh = new THREE.Mesh(originGeo, originMat);
  originMesh.position.copy(originPos);
  originMesh.layers.enable(BLOOM_LAYER);
  globe.add(originMesh);

  const originHaloTex = makeGlowSprite(128, 'rgba(214,69,69,1.0)', 'rgba(214,69,69,0.3)');
  const originHaloMat = track(new THREE.SpriteMaterial({
    map: originHaloTex, blending: THREE.AdditiveBlending, transparent: true,
    depthWrite: false, opacity: 0.9,
  }));
  const originHalo = new THREE.Sprite(originHaloMat);
  originHalo.position.copy(originPos);
  originHalo.scale.setScalar(0.42);
  originHalo.layers.enable(BLOOM_LAYER);
  globe.add(originHalo);

  // -------------------------------------------------------------------------
  // Arcs: one thin TubeGeometry per route with a discard-based traveling dash.
  // The dash is driven entirely by a uniform increment (zero geometry churn).
  // Each arc carries a per-vertex relDistance (0..1 along the curve) and a
  // staggered initial offset so the network feels alive, not synchronized.
  // -------------------------------------------------------------------------
  const arcUniforms = { value: 0 }; // shared dashTranslate accumulator
  const arcs = [];
  const arcOrigin = originPos.clone();

  function buildArc(destIndex, idx) {
    const d = DESTS[destIndex];
    const curve = makeArcCurve(arcOrigin, latLngToVec3(d.lat, d.lng, 0.004), arcAltJitter[destIndex]);
    const curveRes = 48, circRes = 5, stroke = 0.012;
    const geo = track(new THREE.TubeGeometry(curve, curveRes, stroke, circRes, false));

    // per-vertex relDistance, reversed so the dash travels origin -> dest
    const rings = curveRes + 1, perRing = circRes + 1;
    const rel = new Float32Array(rings * perRing);
    let k = 0;
    for (let v = 0; v < rings; v++) {
      const dd = v / (rings - 1);
      for (let s = 0; s < perRing; s++) rel[k++] = dd;
    }
    for (let i = 0; i < rel.length; i++) rel[i] = 1 - rel[i];
    geo.setAttribute('relDistance', new THREE.Float32BufferAttribute(rel, 1));

    // per-vertex radial coordinate across the tube cross-section (-1 edge .. 0
    // center .. +1 edge). A parabolic alpha falloff in the shader fades the tube
    // edges to zero, so the 5-sided extrusion reads as a soft round glowing
    // filament instead of a faceted ribbon.
    const radial = new Float32Array(rings * perRing);
    let r2 = 0;
    for (let v = 0; v < rings; v++)
      for (let s = 0; s < perRing; s++)
        radial[r2++] = (s / (perRing - 1)) * 2.0 - 1.0;
    geo.setAttribute('aRadial', new THREE.Float32BufferAttribute(radial, 1));

    const mat = track(new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(OXIDE_RED).multiplyScalar(2.0) },
        uDashTranslate: arcUniforms,
        uDashOffset: { value: arcOffsets[idx] },   // fully desynchronized stagger
        uDashSize: { value: 0.16 },
        uGapSize: { value: 0.78 },
        uHighlight: { value: 0.0 },           // eased 0..1 on hover
        uBase: { value: 0.12 },               // faint always-on wire
      },
      vertexShader: /* glsl */`
        uniform float uDashTranslate;
        attribute float relDistance;
        attribute float aRadial;
        varying float vRel;
        varying float vRadial;
        void main() {
          vRel = relDistance + uDashTranslate;
          vRadial = aRadial;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uDashOffset, uDashSize, uGapSize, uHighlight, uBase;
        varying float vRel;
        varying float vRadial;
        void main() {
          float period = uDashSize + uGapSize;
          float seg = mod(vRel - uDashOffset, period);
          // normalized position INSIDE the packet: 0 = head .. 1 = tail
          float tInDash = seg / uDashSize;
          float body = step(seg, uDashSize);              // gate to the dash region
          float head = smoothstep(0.0, 0.12, tInDash);    // soft anti-aliased head
          float comet = body * head * exp(-tInDash * 3.5);// bright head, fading tail
          // faint always-on wire so the route stays legible between packets
          float wire = uBase * (0.35 + uHighlight);
          float a = wire + comet * (0.9 + uHighlight * 0.7);
          // parabolic cross-section: soft round filament, edges fade to zero
          a *= 1.0 - vRadial * vRadial;
          if (a < 0.008) discard;
          // incandescent white tip at the comet head
          vec3 col = uColor * (0.7 + uHighlight * 0.5) + vec3(comet * 0.35);
          gl_FragColor = vec4(col, a);
        }
      `,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.layers.enable(BLOOM_LAYER);
    globe.add(mesh);
    return { mesh, mat, destIndex, highlight: 0, highlightTarget: 0 };
  }
  DESTS.forEach((_, i) => arcs.push(buildArc(i, i)));

  // -------------------------------------------------------------------------
  // Selective bloom: two-composer + layers. The bloom pass renders ONLY the
  // glowing objects (everything else swapped to black), then a mix pass adds it
  // back onto the crisp base render. This keeps the dark Earth from graying out
  // (plain whole-scene bloom is additive and lifts the blacks).
  // -------------------------------------------------------------------------
  const darkMat = track(new THREE.MeshBasicMaterial({ color: 0x000000 }));
  const savedMats = {};
  const bloomLayerMask = new THREE.Layers();
  bloomLayerMask.set(BLOOM_LAYER);

  const renderPass = new RenderPass(scene, camera);
  // threshold raised off 0 so the broad cool atmosphere haze no longer blooms
  // uniformly (which lifts the blacks); only the hot nodes/arcs + the warm
  // terminator peak clear it. Tighter radius -> a lens halo, not glow soup.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.4, 0.2);

  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(renderPass);
  bloomComposer.addPass(bloomPass);

  const mixPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      baseTexture: { value: null },
      bloomTexture: { value: bloomComposer.renderTarget2.texture },
      // bloom contribution lever: <1 keeps the oxide-red cores from desaturating
      // toward white when the HDR emissive + bloom ride into ACES downstream.
      uBloomStrength: { value: 0.85 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D baseTexture;
      uniform sampler2D bloomTexture;
      uniform float uBloomStrength;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(baseTexture, vUv) + uBloomStrength * texture2D(bloomTexture, vUv);
      }
    `,
  }), 'baseTexture');
  mixPass.needsSwap = true;
  track(mixPass.material);

  // Once EffectComposer takes over, the renderer's MSAA (antialias:true) is
  // bypassed -- the Earth limb and the thin arc tubes crawl with aliasing, the
  // single biggest "render, not photo" tell. SMAA re-crisps them. It operates in
  // linear-sRGB so it MUST run BEFORE OutputPass (which applies ACES + sRGB).
  // Initial size from the mount; finalComposer.setSize() keeps it in sync on
  // resize (SMAAPass.setSize resizes its edge/weight RTs). Only one extra pass.
  const smaaPass = new SMAAPass(
    Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight));

  // Final cinematic grade in DISPLAY (sRGB) space, AFTER OutputPass: a smooth
  // radial vignette to draw the eye to the network, a whisper of edge-weighted
  // chromatic aberration (lens realism, center stays clean), and low-amplitude
  // time-varying grain so the dark ocean gradient doesn't band under ACES+bloom.
  // Folded into ONE ShaderPass (three effects, one fullscreen tap budget).
  const gradePass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uTime: uTime,                     // reuse the existing elapsed-time uniform
      uVignette: { value: 1.08 },       // overall vignette strength
      uVignetteSoft: { value: 0.55 },   // inner falloff radius
      uAberration: { value: 0.0016 },   // max channel split at the frame edge
      uGrain: { value: 0.024 },         // film grain amplitude (0 = off)
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float uTime, uVignette, uVignetteSoft, uAberration, uGrain;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 d = vUv - 0.5;
        float r2 = dot(d, d);                         // radial^2 -> edge-weighted CA
        // radial chromatic aberration: split grows with distance from center, so
        // the center (where the globe sits) stays perfectly clean.
        vec2 dir = d * uAberration * (0.4 + r2 * 4.0);
        float cr = texture2D(tDiffuse, vUv + dir).r;
        float cg = texture2D(tDiffuse, vUv).g;
        float cb = texture2D(tDiffuse, vUv - dir).b;
        vec3 col = vec3(cr, cg, cb);
        // smooth radial vignette: darkens the corners, never crushes the center.
        float vig = smoothstep(0.85, uVignetteSoft, length(d) * uVignette);
        col *= mix(1.0, 0.62, 1.0 - vig);
        // grain centered on 0 (the -0.5) so it textures without lifting the blacks.
        float g = (hash(vUv * vec2(1920.0, 1080.0) + fract(uTime)) - 0.5) * uGrain;
        col += g;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }));
  track(gradePass.material);

  const finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(renderPass);
  finalComposer.addPass(mixPass);
  finalComposer.addPass(smaaPass);          // crisp edges (linear-sRGB, pre-OutputPass)
  const outputPass = new OutputPass();      // ACES tone map + sRGB encode
  finalComposer.addPass(outputPass);        // captured so dispose() can free its material + fsQuad
  finalComposer.addPass(gradePass);         // vignette + CA + grain (display space)

  function darkenNonBloom(obj) {
    if (obj.isMesh && bloomLayerMask.test(obj.layers) === false) {
      savedMats[obj.uuid] = obj.material;
      obj.material = darkMat;
    } else if ((obj.isSprite || obj.isPoints) && bloomLayerMask.test(obj.layers) === false) {
      // sprites + the starfield Points are hidden during the bloom pass so they
      // neither bloom nor double-composite (they're not on the bloom layer).
      savedMats[obj.uuid] = obj.visible;
      obj.visible = false;
    }
  }
  function restoreMaterial(obj) {
    if (savedMats[obj.uuid] !== undefined) {
      if (obj.isSprite || obj.isPoints) obj.visible = savedMats[obj.uuid];
      else obj.material = savedMats[obj.uuid];
      delete savedMats[obj.uuid];
    }
  }

  function renderComposite() {
    scene.traverse(darkenNonBloom);
    bloomComposer.render();
    scene.traverse(restoreMaterial);
    finalComposer.render();
  }

  // -------------------------------------------------------------------------
  // Interaction state
  // Globe rotated via quaternion (Euler accumulation flips past 180deg).
  // azim/polar ease toward cursor-derived targets; spin is a separate
  // always-advancing auto-rotate accumulator; scroll feeds azim on touch.
  // -------------------------------------------------------------------------
  const hasHover = !window.matchMedia || window.matchMedia('(hover: hover)').matches;
  const POLAR_LIMIT = 0.5;
  const DRAG_POLAR_LIMIT = 0.55;         // vertical-drag pitch clamp (rad)
  let azim = 0, polar = 0, azimT = 0, polarT = 0, spin = 0;
  let hoverAmt = 0, hoverTarget = 0;     // eases auto-rotate down on hover
  let inputActive = false;

  // Drag-to-orbit state. While dragging, pointer DELTA drives the globe:
  // horizontal = unbounded azimuth (true 360 spin, accumulated into dragYaw),
  // vertical = pitch clamped to +/-DRAG_POLAR_LIMIT. On release we keep a
  // little angular velocity (dragVelX/Y) that decays for inertia.
  let dragging = false;
  let dragPointerId = -1;
  let lastDragX = 0, lastDragY = 0;
  let dragYaw = 0;                        // unbounded accumulated drag azimuth
  let dragPitch = -0.12;                  // clamped drag pitch
  let dragVelX = 0, dragVelY = 0;        // last-frame angular velocity (inertia)
  const DRAG_SENS = 0.0045;              // rad per CSS pixel of drag
  const INERTIA_DECAY = 3.0;            // per-second exponential-ish falloff

  const qYaw = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();
  const AX = new THREE.Vector3(1, 0, 0);
  const AY = new THREE.Vector3(0, 1, 0);

  function applyOrbit() {
    azim += (azimT - azim) * 0.08;
    polar += (polarT - polar) * 0.08;
    // dragYaw is unbounded (true 360 spin) and accumulates from drag deltas +
    // inertia; dragPitch is the clamped vertical-drag pitch. The subtle cursor
    // parallax (azim/polar) layers on top of both, and spin is the idle rotate.
    qYaw.setFromAxisAngle(AY, spin + azim + dragYaw);
    qPitch.setFromAxisAngle(AX, dragPitch + polar);
    globe.quaternion.copy(qPitch).multiply(qYaw);
    // keep sprites facing camera-scaled; counter-tilt origin halo bias not needed
  }

  // -------------------------------------------------------------------------
  // Picking: raycast the node InstancedMesh on pointermove only. Highlight via
  // uHover uniform (nodes) + per-arc uHighlight (arc whose dest is hovered).
  // -------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoveredId = -1;

  function pick(clientX, clientY) {
    const r = mount.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(nodeMesh, false);
    const id = hits.length ? hits[0].instanceId : -1;
    if (id !== hoveredId) {
      hoveredId = id;
      uHover.value = id;
      for (const a of arcs) a.highlightTarget = (a.destIndex === id) ? 1 : 0;
    }
  }

  // -------------------------------------------------------------------------
  // Input handlers (only when not reduced motion)
  // -------------------------------------------------------------------------
  function onPointerDown(e) {
    // begin a drag: capture the pointer so move/up keep firing outside the
    // element, kill inertia, and switch the cursor to grabbing.
    dragging = true;
    dragPointerId = e.pointerId;
    lastDragX = e.clientX;
    lastDragY = e.clientY;
    dragVelX = 0; dragVelY = 0;
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
    renderer.domElement.style.cursor = 'grabbing';
    inputActive = true;
    ensureRunning();
  }

  function onPointerMove(e) {
    if (dragging && e.pointerId === dragPointerId) {
      // pointer DELTA -> rotation. horizontal = unbounded azimuth (never clamp
      // or wrap-limit); vertical = pitch clamped to +/-DRAG_POLAR_LIMIT.
      const dx = e.clientX - lastDragX;
      const dy = e.clientY - lastDragY;
      lastDragX = e.clientX;
      lastDragY = e.clientY;
      const yawStep = dx * DRAG_SENS;
      const pitchStep = dy * DRAG_SENS;
      dragYaw += yawStep;                              // accumulate, no clamp
      dragPitch = clamp(dragPitch + pitchStep, -DRAG_POLAR_LIMIT, DRAG_POLAR_LIMIT);
      dragVelX = yawStep;                              // remembered for inertia
      dragVelY = (dragPitch > -DRAG_POLAR_LIMIT && dragPitch < DRAG_POLAR_LIMIT) ? pitchStep : 0;
      pick(e.clientX, e.clientY);
      ensureRunning();
      return;
    }
    // subtle cursor parallax (small offset layered on the drag/idle rotation).
    const r = mount.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    azimT = nx * 0.6;
    polarT = clamp(-ny * 0.4, -POLAR_LIMIT, POLAR_LIMIT);
    inputActive = true;
    pick(e.clientX, e.clientY);
    ensureRunning();
  }

  function onPointerUp(e) {
    if (!dragging || e.pointerId !== dragPointerId) return;
    dragging = false;
    dragPointerId = -1;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
    renderer.domElement.style.cursor = 'grab';
    // inertia is carried by dragVelX/dragVelY and decays in step().
    ensureRunning();
  }

  function onPointerLeave() {
    if (dragging) return;                // a capture-drag may run past the edge
    azimT = 0; polarT = 0;
    hoveredId = -1; uHover.value = -1;
    for (const a of arcs) a.highlightTarget = 0;
    inputActive = false;
    ensureRunning();
  }
  function onEnter() { hoverTarget = 1; ensureRunning(); }
  function onLeaveHover() { hoverTarget = 0; }

  // scroll-progress fallback so it animates on touch (no hover). Read the rect
  // once per RAF frame (never inside the scroll listener) to avoid layout thrash.
  let scrollDriven = 0;
  function scrollProgress() {
    const r = mount.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    return clamp((vh - r.top) / (vh + r.height), 0, 1);
  }
  function onScroll() { if (!hasHover) ensureRunning(); }

  // -------------------------------------------------------------------------
  // Visibility gating: the loop must STOP when the card scrolls offscreen so we
  // never run RAF forever at idle. While visible, the slow auto-rotate + node
  // pulses + arc dashes are the legitimate continuous animation.
  // -------------------------------------------------------------------------
  let inView = false;
  const io = new IntersectionObserver(([en]) => {
    inView = en.isIntersecting;
    if (inView) { if (active) ensureRunning(); }
    else stopLoop();
  }, { threshold: 0 });

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------
  function resize() {
    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    bloomComposer.setSize(w, h);
    finalComposer.setSize(w, h);
    starMat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  }
  const ro = new ResizeObserver(() => {
    resize();
    if (reduced) renderStaticFrame();
    else ensureRunning();
  });

  // -------------------------------------------------------------------------
  // Context-loss guard (rebuild PMREM env on restore)
  // -------------------------------------------------------------------------
  const onLost = e => { e.preventDefault(); running = false; if (raf) cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => {
    const oldEnv = envTex;
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    if (oldEnv) oldEnv.dispose();
    nodeMesh.computeBoundingSphere();
    resize();
    if (reduced) renderStaticFrame();
    else if (active) ensureRunning();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  // -------------------------------------------------------------------------
  // Frame update + on-demand RAF
  // -------------------------------------------------------------------------
  const IDLE_RATE = 0.06;       // rad/s slow auto-rotate
  let running = false, raf = 0, last = 0, active = false;

  function step(dt, elapsed) {
    uTime.value = elapsed;
    uTimeStars.value = elapsed;       // GPU twinkle

    // hover ease (auto-rotate slows while user steers)
    hoverAmt += (hoverTarget - hoverAmt) * 0.08;
    spin += dt * IDLE_RATE * (1 - 0.7 * hoverAmt);

    // release inertia: when not dragging, keep applying the last drag velocity
    // and decay it so the globe coasts to a stop. Pitch coast stays clamped.
    if (!dragging) {
      if (dragVelX !== 0 || dragVelY !== 0) {
        dragYaw += dragVelX;
        dragPitch = clamp(dragPitch + dragVelY, -DRAG_POLAR_LIMIT, DRAG_POLAR_LIMIT);
        const decay = Math.max(0, 1 - INERTIA_DECAY * dt);
        dragVelX *= decay;
        dragVelY *= decay;
        if (Math.abs(dragVelX) < 1e-5) dragVelX = 0;
        if (Math.abs(dragVelY) < 1e-5) dragVelY = 0;
      }
    }

    // touch fallback: ease azim target from scroll position
    if (!hasHover && inView) {
      scrollDriven = scrollProgress();
      azimT = (scrollDriven - 0.5) * 1.4;
    }

    applyOrbit();

    // clouds drift a touch faster than the surface (subtle weather motion).
    clouds.rotation.y += dt * 0.012;

    // traveling dash (three-globe formula, kept bounded)
    arcUniforms.value = (arcUniforms.value + dt * 0.55) % 1e6;
    for (const a of arcs) {
      a.highlight += (a.highlightTarget - a.highlight) * 0.12;
      a.mat.uniforms.uHighlight.value = a.highlight;
    }

    // node + halo pulse (sprite scale/opacity breathe with the shader pulse)
    for (let i = 0; i < halos.length; i++) {
      const p = 0.55 + 0.45 * Math.sin(elapsed * 2.2 + halos[i].phase);
      const hot = (i === hoveredId) ? 1.7 : 1.0;
      halos[i].sprite.scale.setScalar((0.18 + p * 0.08) * hot);
      halos[i].sprite.material.opacity = 0.4 + p * 0.3; // per-halo material breathes independently
    }
    const op = 0.6 + 0.4 * Math.sin(elapsed * 2.0);
    originHalo.scale.setScalar(0.38 + op * 0.1);
  }

  function tick(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const elapsed = now / 1000;

    step(dt, elapsed);
    renderComposite();

    // The globe always has live motion while visible (auto-rotate, pulses,
    // dashes), so the loop runs while in-view and FULLY stops when offscreen.
    if (inView) raf = requestAnimationFrame(tick);
    else { running = false; raf = 0; }
  }

  function ensureRunning() {
    if (reduced || running || !inView) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (!running) return;
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Reduced motion: ONE well-composed static frame, no listeners, no loop.
  function renderStaticFrame() {
    azim = 0.35; polar = 0; dragPitch = -0.16; dragYaw = 0; spin = 0.4;
    uTime.value = 1.2;
    uTimeStars.value = 1.2;   // composed twinkle phase for the still
    clouds.rotation.y = 0.4;  // composed cloud position for the still
    applyOrbit();
    arcUniforms.value = 0.35; // freeze dashes mid-flight for a lively still
    for (let i = 0; i < halos.length; i++) halos[i].sprite.scale.setScalar(0.2);
    originHalo.scale.setScalar(0.42);
    renderComposite();
  }

  resize();

  return {
    start() {
      active = true;
      resize();
      if (reduced) {
        // attach NO input listeners; only observe size for a re-rendered still
        ro.observe(mount);
        requestAnimationFrame(renderStaticFrame);
        return;
      }
      ro.observe(mount);
      io.observe(mount);
      // Drag-to-orbit works for mouse + touch alike: pointerdown/up on the
      // canvas (with pointer capture), and a canvas-level pointermove so drag
      // tracking continues even on touch devices that lack hover.
      const el = renderer.domElement;
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerUp);
      if (hasHover) {
        mount.addEventListener('pointermove', onPointerMove);
        mount.addEventListener('pointerleave', onPointerLeave);
        mount.addEventListener('pointerenter', onEnter);
        mount.addEventListener('pointerleave', onLeaveHover);
      } else {
        el.addEventListener('pointermove', onPointerMove);
        window.addEventListener('scroll', onScroll, { passive: true });
      }
      ensureRunning();
    },
    stop() {
      active = false;
      stopLoop();
    },
    dispose() {
      this.stop();
      ro.disconnect();
      io.disconnect();
      const el = renderer.domElement;
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      if (hasHover) {
        mount.removeEventListener('pointermove', onPointerMove);
        mount.removeEventListener('pointerleave', onPointerLeave);
        mount.removeEventListener('pointerenter', onEnter);
        mount.removeEventListener('pointerleave', onLeaveHover);
      } else {
        el.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('scroll', onScroll);
      }
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);

      // dispose geometries/materials/textures/instanced meshes
      nodeMesh.dispose(); // frees the per-instance matrix/attribute buffers
      disposables.forEach(d => d && d.dispose && d.dispose());
      // composers each hold two render targets + the bloom pass holds several
      bloomComposer.dispose();
      finalComposer.dispose();
      bloomPass.dispose();
      smaaPass.dispose(); // holds two SMAA lookup textures + a render target
      // EffectComposer.dispose() only frees its own render targets + copyPass, NOT
      // user-added passes -- so free each post pass' fsQuad (and material) here.
      // (mixPass/gradePass materials are also tracked; Material.dispose() is
      // idempotent so the second call is a harmless no-op.)
      outputPass.dispose();
      mixPass.dispose();
      gradePass.dispose();
      if (envTex) envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
