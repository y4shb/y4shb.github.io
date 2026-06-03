import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// DCAuto teardown card: realistic data-center MCM accelerator package that
// auto-explodes/reassembles on a slow loop and accelerates while the parent
// .proj-card is hovered. Ported from demos/final/dcauto-chip-b.html (full
// viewport, OrbitControls) to a self-contained ~180px card module that drives
// its own camera and gates the RAF via start()/stop().

const OXIDE_RED = '#d64545';

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);

  // -------------------------------------------------------------------------
  // Renderer
  // -------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0a0a0a, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  mount.appendChild(renderer.domElement);

  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);

  // -------------------------------------------------------------------------
  // Environment (IBL) for believable metal reflections, not used as background.
  // -------------------------------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  // 3-point light rig with a single oxide-red accent on the rim.
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(6, 10, 6);
  const fill = new THREE.DirectionalLight(0xaecbff, 0.6); fill.position.set(-8, 4, 4);
  const rim = new THREE.DirectionalLight(0xd64545, 1.5); rim.position.set(-4, 6, -9);
  scene.add(key, fill, rim);
  scene.add(new THREE.AmbientLight(0x303438, 0.35));

  // Track every disposable (geometries, materials, textures) for teardown.
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  // -------------------------------------------------------------------------
  // Canvas / texture helpers
  // -------------------------------------------------------------------------
  function makeCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }
  function colorTexture(canvas, repeat = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }
  function dataTexture(canvas, repeat = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }
  function normalTexture(canvas, repeat = 1) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = MAX_ANISO;
    t.needsUpdate = true;
    return track(t);
  }

  // Height (grayscale luminance) -> tangent-space normal map.
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
  // Procedural textures (sizes tuned for a small card + retina crispness)
  // -------------------------------------------------------------------------

  // Silicon interposer top: dense fine routing grid + faint TSV via field.
  function makeInterposerTex({ size = 512, seed = 11 } = {}) {
    const rng = mulberry32(seed);
    const alb = makeCanvas(size);
    const actx = alb.getContext('2d');
    const bump = makeCanvas(size);
    const bctx = bump.getContext('2d');
    bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, size, size);

    const g = actx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#1c222b');
    g.addColorStop(0.5, '#232b35');
    g.addColorStop(1, '#191e26');
    actx.fillStyle = g; actx.fillRect(0, 0, size, size);

    const cell = 6;
    actx.strokeStyle = 'rgba(120,140,170,0.05)';
    actx.lineWidth = 1;
    for (let x = 0; x <= size; x += cell) { actx.beginPath(); actx.moveTo(x, 0); actx.lineTo(x, size); actx.stroke(); }
    for (let y = 0; y <= size; y += cell) { actx.beginPath(); actx.moveTo(0, y); actx.lineTo(size, y); actx.stroke(); }

    actx.strokeStyle = 'rgba(150,95,55,0.18)';
    actx.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      let x = rng() * size, y = rng() * size;
      actx.beginPath(); actx.moveTo(x, y);
      const segs = 3 + (rng() * 4 | 0);
      for (let s = 0; s < segs; s++) {
        if (rng() < 0.5) x += (rng() < 0.5 ? -1 : 1) * (40 + rng() * 160);
        else y += (rng() < 0.5 ? -1 : 1) * (40 + rng() * 160);
        actx.lineTo(x, y);
      }
      actx.stroke();
    }

    for (let i = 0; i < 500; i++) {
      const x = rng() * size, y = rng() * size, r = 1 + rng() * 1.2;
      actx.fillStyle = 'rgba(90,70,50,0.35)';
      actx.beginPath(); actx.arc(x, y, r, 0, Math.PI * 2); actx.fill();
      bctx.fillStyle = '#9a9a9a';
      bctx.beginPath(); bctx.arc(x, y, r, 0, Math.PI * 2); bctx.fill();
    }

    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#4a4a4a'; rctx.fillRect(0, 0, size, size);
    rctx.globalAlpha = 0.4; rctx.drawImage(bump, 0, 0); rctx.globalAlpha = 1;

    return {
      map: colorTexture(alb),
      roughnessMap: dataTexture(rough),
      normalMap: normalTexture(heightToNormalCanvas(bump, 0.6)),
    };
  }

  // Compute die: circuitry grid + functional blocks + faint oxide-red emissive.
  function makeSiliconDie({ size = 512, seed = 42, glow = true } = {}) {
    const rng = mulberry32(seed);
    const alb = makeCanvas(size);
    const actx = alb.getContext('2d');
    const bump = makeCanvas(size);
    const bctx = bump.getContext('2d');
    bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, size, size);

    const g = actx.createLinearGradient(0, 0, size, 0);
    g.addColorStop(0, '#0a0d14');
    g.addColorStop(0.5, '#10141d');
    g.addColorStop(1, '#090c12');
    actx.fillStyle = g; actx.fillRect(0, 0, size, size);

    const cell = 7;
    actx.strokeStyle = 'rgba(140,160,195,0.055)';
    actx.lineWidth = 1;
    for (let x = 0; x <= size; x += cell) { actx.beginPath(); actx.moveTo(x, 0); actx.lineTo(x, size); actx.stroke(); }
    for (let y = 0; y <= size; y += cell) { actx.beginPath(); actx.moveTo(0, y); actx.lineTo(size, y); actx.stroke(); }
    bctx.strokeStyle = 'rgba(140,140,140,1)';
    bctx.lineWidth = 1;
    for (let x = 0; x <= size; x += cell) { bctx.beginPath(); bctx.moveTo(x, 0); bctx.lineTo(x, size); bctx.stroke(); }

    const blocks = 8;
    for (let i = 0; i < blocks; i++) {
      const bw = 50 + rng() * 160, bh = 40 + rng() * 140;
      const bx = rng() * (size - bw), by = rng() * (size - bh);
      const shade = 0.05 + rng() * 0.07;
      actx.fillStyle = `rgba(${rng() < 0.5 ? '110,130,160' : '60,72,90'},${shade})`;
      actx.fillRect(bx, by, bw, bh);
      actx.strokeStyle = 'rgba(165,180,210,0.09)';
      actx.lineWidth = 1;
      actx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
      if (rng() < 0.6) {
        actx.strokeStyle = 'rgba(155,170,200,0.05)';
        for (let x = bx; x < bx + bw; x += 4) {
          actx.beginPath(); actx.moveTo(x, by); actx.lineTo(x, by + bh); actx.stroke();
        }
      }
      bctx.fillStyle = 'rgba(150,150,150,0.18)';
      bctx.fillRect(bx, by, bw, bh);
    }

    actx.fillStyle = 'rgba(175,188,205,0.16)';
    const pad = 5, gap = 12;
    for (let p = gap; p < size - gap; p += gap) {
      actx.fillRect(p, 5, pad, 3);
      actx.fillRect(p, size - 8, pad, 3);
      actx.fillRect(5, p, 3, pad);
      actx.fillRect(size - 8, p, 3, pad);
    }

    const emi = makeCanvas(size);
    const ectx = emi.getContext('2d');
    ectx.fillStyle = '#000'; ectx.fillRect(0, 0, size, size);
    if (glow) {
      ectx.strokeStyle = OXIDE_RED;
      ectx.lineCap = 'round';
      for (let i = 0; i < 9; i++) {
        let x = rng() * size, y = rng() * size;
        ectx.globalAlpha = 0.22 + rng() * 0.3;
        ectx.lineWidth = rng() < 0.3 ? 1.4 : 0.8;
        ectx.beginPath(); ectx.moveTo(x, y);
        const segs = 4 + (rng() * 5 | 0);
        for (let s = 0; s < segs; s++) {
          if (rng() < 0.5) x += (rng() < 0.5 ? -1 : 1) * (18 + rng() * 80);
          else y += (rng() < 0.5 ? -1 : 1) * (18 + rng() * 80);
          ectx.lineTo(x, y);
        }
        ectx.stroke();
      }
      for (let i = 0; i < 5; i++) {
        ectx.globalAlpha = 0.55;
        ectx.fillStyle = OXIDE_RED;
        ectx.beginPath();
        ectx.arc(rng() * size, rng() * size, 1.4 + rng() * 1.4, 0, Math.PI * 2);
        ectx.fill();
      }
      ectx.globalAlpha = 1;
    }

    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#2e3236'; rctx.fillRect(0, 0, size, size);
    rctx.globalAlpha = 0.4; rctx.drawImage(bump, 0, 0); rctx.globalAlpha = 1;

    return {
      map: colorTexture(alb),
      roughnessMap: dataTexture(rough),
      normalMap: normalTexture(heightToNormalCanvas(bump, 0.4)),
      emissiveMap: colorTexture(emi),
    };
  }

  // HBM stack top: moulded grey with a faint die-edge laminate banding.
  function makeHBMTex({ size = 256, seed = 71 } = {}) {
    const rng = mulberry32(seed);
    const alb = makeCanvas(size);
    const actx = alb.getContext('2d');
    actx.fillStyle = '#26262b'; actx.fillRect(0, 0, size, size);
    actx.globalAlpha = 0.08;
    for (let y = 0; y < size; y += 6) {
      actx.fillStyle = (y / 6) % 2 ? '#33333a' : '#1d1d22';
      actx.fillRect(0, y, size, 3);
    }
    actx.globalAlpha = 1;
    for (let i = 0; i < 900; i++) {
      const x = rng() * size, y = rng() * size, r = rng() * 1.4;
      actx.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(70,70,78,0.1)';
      actx.beginPath(); actx.arc(x, y, r, 0, Math.PI * 2); actx.fill();
    }
    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#b0b0b0'; rctx.fillRect(0, 0, size, size);
    return { map: colorTexture(alb), roughnessMap: dataTexture(rough) };
  }

  // Organic substrate: dark solder mask + copper traces + vias + silk refs.
  function makeSubstrateTex({ size = 512, seed = 21 } = {}) {
    const rng = mulberry32(seed);
    const bump = makeCanvas(size);
    const bctx = bump.getContext('2d');
    bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, size, size);

    const alb = makeCanvas(size);
    const actx = alb.getContext('2d');
    actx.fillStyle = '#0d1310'; actx.fillRect(0, 0, size, size);

    actx.globalAlpha = 0.06;
    for (let i = 0; i < 4000; i++) {
      const x = rng() * size, y = rng() * size, r = rng() * 2;
      actx.fillStyle = rng() < 0.5 ? '#000' : '#1a221c';
      actx.beginPath(); actx.arc(x, y, r, 0, Math.PI * 2); actx.fill();
    }
    actx.globalAlpha = 1;

    const drawTrace = (cctx, rfn, color, lw, n) => {
      cctx.strokeStyle = color; cctx.lineWidth = lw;
      cctx.lineCap = 'round'; cctx.lineJoin = 'round';
      for (let i = 0; i < n; i++) {
        let x = rfn() * size, y = rfn() * size;
        cctx.beginPath(); cctx.moveTo(x, y);
        const segs = 3 + (rfn() * 4 | 0);
        for (let s = 0; s < segs; s++) {
          if (rfn() < 0.5) x += (rfn() < 0.5 ? -1 : 1) * (40 + rfn() * 180);
          else y += (rfn() < 0.5 ? -1 : 1) * (40 + rfn() * 180);
          cctx.lineTo(x, y);
        }
        cctx.stroke();
      }
    };
    drawTrace(actx, rng, '#5e4026', 2.4, 22);
    // mirror identical trace shapes into the bump map
    drawTrace(bctx, mulberry32(seed), '#b8b8b8', 2.4, 22);

    for (let i = 0; i < 70; i++) {
      const x = rng() * size, y = rng() * size, r = 3 + rng() * 2;
      actx.fillStyle = '#6a4a2a';
      actx.beginPath(); actx.arc(x, y, r, 0, Math.PI * 2); actx.fill();
      actx.fillStyle = '#05070a';
      actx.beginPath(); actx.arc(x, y, r * 0.5, 0, Math.PI * 2); actx.fill();
      bctx.fillStyle = '#cfcfcf';
      bctx.beginPath(); bctx.arc(x, y, r, 0, Math.PI * 2); bctx.fill();
      bctx.fillStyle = '#202020';
      bctx.beginPath(); bctx.arc(x, y, r * 0.5, 0, Math.PI * 2); bctx.fill();
    }

    actx.fillStyle = '#c9cdd2';
    actx.font = '11px monospace';
    const refs = ['U1', 'C7', 'R12', 'TP3', 'J2', 'L4', 'HBM0', 'HBM3'];
    for (let i = 0; i < 16; i++) {
      const x = rng() * size, y = rng() * size;
      actx.fillText(refs[(rng() * refs.length) | 0], x, y);
    }
    actx.beginPath();
    actx.moveTo(40, 40); actx.lineTo(64, 40); actx.lineTo(40, 64); actx.closePath();
    actx.fill();
    bctx.fillStyle = '#bdbdbd';
    bctx.beginPath();
    bctx.moveTo(40, 40); bctx.lineTo(64, 40); bctx.lineTo(40, 64); bctx.closePath();
    bctx.fill();

    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#cfcfcf'; rctx.fillRect(0, 0, size, size);

    return {
      map: colorTexture(alb),
      roughnessMap: dataTexture(rough),
      normalMap: normalTexture(heightToNormalCanvas(bump, 1.3)),
    };
  }

  // BGA underside field between balls: dark mask + copper land rings.
  function makeBGAField({ size = 512, cols = 26, seed = 3 } = {}) {
    const alb = makeCanvas(size);
    const actx = alb.getContext('2d');
    const bump = makeCanvas(size);
    const bctx = bump.getContext('2d');
    bctx.fillStyle = '#808080'; bctx.fillRect(0, 0, size, size);
    actx.fillStyle = '#0b0f0c'; actx.fillRect(0, 0, size, size);

    const step = size / cols;
    const padR = step * 0.30;
    for (let r = 0; r < cols; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * step, y = (r + 0.5) * step;
        actx.fillStyle = '#5a3e22';
        actx.beginPath(); actx.arc(x, y, padR, 0, Math.PI * 2); actx.fill();
        actx.fillStyle = '#9a9ea6';
        actx.beginPath(); actx.arc(x - padR * 0.2, y - padR * 0.2, padR * 0.5, 0, Math.PI * 2); actx.fill();
        bctx.fillStyle = '#c8c8c8';
        bctx.beginPath(); bctx.arc(x, y, padR, 0, Math.PI * 2); bctx.fill();
      }
    }
    const rough = makeCanvas(size);
    const rctx = rough.getContext('2d');
    rctx.fillStyle = '#c0c0c0'; rctx.fillRect(0, 0, size, size);
    for (let r = 0; r < cols; r++) for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * step, y = (r + 0.5) * step;
      rctx.fillStyle = '#4a4a4a';
      rctx.beginPath(); rctx.arc(x, y, padR, 0, Math.PI * 2); rctx.fill();
    }
    return {
      map: colorTexture(alb),
      roughnessMap: dataTexture(rough),
      normalMap: normalTexture(heightToNormalCanvas(bump, 1.0)),
    };
  }

  // Generic laser-etched markings for the substrate corner (IP-safe).
  function makeEtchTexture({ size = 512 } = {}) {
    const c = makeCanvas(size);
    const x = c.getContext('2d');
    x.clearRect(0, 0, size, size);
    x.fillStyle = 'rgba(190,196,205,0.9)';
    x.textAlign = 'left';
    x.font = `bold ${Math.round(size * 0.085)}px monospace`;
    x.fillText('DCAUTO', size * 0.08, size * 0.20);
    x.font = `${Math.round(size * 0.05)}px monospace`;
    x.fillText('DC-GPU MI-CLASS', size * 0.08, size * 0.31);
    x.fillText('LOT 2X45-DCA', size * 0.08, size * 0.40);
    x.fillText('SN 0xAF12C9-7C', size * 0.08, size * 0.48);
    x.fillText('DIFFUSED ASSY GENERIC', size * 0.08, size * 0.56);
    const rng = mulberry32(1234);
    const o = size * 0.70, oy = size * 0.18, cells = 14, s = (size * 0.22) / cells;
    x.fillStyle = 'rgba(180,186,195,0.9)';
    for (let i = 0; i < cells; i++)
      for (let j = 0; j < cells; j++) {
        const left = i === 0, bottom = j === cells - 1;
        const topDot = j === 0 && i % 2 === 0;
        const rightDot = i === cells - 1 && j % 2 === 1;
        const data = i > 0 && i < cells - 1 && j > 0 && j < cells - 1 && rng() < 0.5;
        if (left || bottom || topDot || rightDot || data)
          x.fillRect(o + i * s, oy + j * s, s, s);
      }
    return colorTexture(c);
  }

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------
  function makeMaterials(tex) {
    const interposer = new THREE.MeshPhysicalMaterial({
      map: tex.interposer.map, roughnessMap: tex.interposer.roughnessMap, normalMap: tex.interposer.normalMap,
      color: 0x2a323d, metalness: 0.5, roughness: 0.2,
      iridescence: 0.4, iridescenceIOR: 1.7, iridescenceThicknessRange: [180, 360],
      clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 1.0,
    });
    const die = new THREE.MeshPhysicalMaterial({
      map: tex.die.map, roughnessMap: tex.die.roughnessMap, normalMap: tex.die.normalMap, emissiveMap: tex.die.emissiveMap,
      emissive: new THREE.Color(OXIDE_RED), emissiveIntensity: 0.85,
      color: 0x0c0e14, metalness: 0.55, roughness: 0.12,
      iridescence: 0.85, iridescenceIOR: 1.8, iridescenceThicknessRange: [180, 360],
      clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 1.0,
    });
    const hbm = new THREE.MeshPhysicalMaterial({
      map: tex.hbm.map, roughnessMap: tex.hbm.roughnessMap,
      color: 0x2c2c33, metalness: 0.1, roughness: 0.7,
      clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.7,
    });
    const substrate = new THREE.MeshPhysicalMaterial({
      map: tex.substrate.map, roughnessMap: tex.substrate.roughnessMap, normalMap: tex.substrate.normalMap,
      color: 0x101314, metalness: 0.0, roughness: 0.6,
      clearcoat: 0.35, clearcoatRoughness: 0.5,
      sheen: 0.2, sheenRoughness: 0.85, sheenColor: new THREE.Color(0x1c2326),
      specularIntensity: 0.55, specularColor: new THREE.Color(0x8a9296), envMapIntensity: 0.5,
    });
    const bgaField = new THREE.MeshPhysicalMaterial({
      map: tex.bga.map, roughnessMap: tex.bga.roughnessMap, normalMap: tex.bga.normalMap,
      metalness: 0.3, roughness: 0.7, envMapIntensity: 0.6,
    });
    const gold = new THREE.MeshPhysicalMaterial({ color: 0xe8b450, metalness: 1.0, roughness: 0.28, envMapIntensity: 1.2 });
    const copper = new THREE.MeshPhysicalMaterial({ color: 0xb05c34, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.1 });
    const microbump = new THREE.MeshPhysicalMaterial({ color: 0xc8a24a, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.1 });
    const solder = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.35, clearcoat: 0.2, envMapIntensity: 1.0 });
    const cap = new THREE.MeshPhysicalMaterial({
      color: 0xb89a72, metalness: 0.0, roughness: 0.85,
      sheen: 0.15, sheenRoughness: 0.9, sheenColor: new THREE.Color(0x9a8260),
      specularIntensity: 0.3, envMapIntensity: 0.4,
    });
    const capEnd = new THREE.MeshPhysicalMaterial({ color: 0xb8bcc0, metalness: 1.0, roughness: 0.4, envMapIntensity: 0.9 });
    const etch = new THREE.MeshPhysicalMaterial({
      map: tex.etch, transparent: true, metalness: 0.2, roughness: 0.55,
      polygonOffset: true, polygonOffsetFactor: -2, envMapIntensity: 0.6,
    });
    const mats = { interposer, die, hbm, substrate, bgaField, gold, copper, microbump, solder, cap, capEnd, etch };
    Object.values(mats).forEach(track);
    return mats;
  }

  // -------------------------------------------------------------------------
  // Sub-builders
  // -------------------------------------------------------------------------
  function buildMicrobumps(mat, w, d, pitch, radius, yTop) {
    const geo = track(new THREE.SphereGeometry(radius, 8, 6));
    geo.scale(1, 0.6, 1);
    const nx = Math.max(2, Math.floor((w * 0.96) / pitch));
    const nz = Math.max(2, Math.floor((d * 0.96) / pitch));
    const startX = -((nx - 1) * pitch) / 2;
    const startZ = -((nz - 1) * pitch) / 2;
    const mesh = new THREE.InstancedMesh(geo, mat, nx * nz);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let ix = 0; ix < nx; ix++)
      for (let iz = 0; iz < nz; iz++) {
        m.makeTranslation(startX + ix * pitch, yTop, startZ + iz * pitch);
        mesh.setMatrixAt(i++, m);
      }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  function buildBGA(mat, w, d, pitch = 0.42) {
    const r = pitch * 0.42;
    const geo = track(new THREE.SphereGeometry(r, 12, 10));
    geo.scale(1, 0.7, 1);
    geo.translate(0, -r * 0.35, 0);
    const nx = Math.floor((w * 0.9) / pitch);
    const nz = Math.floor((d * 0.9) / pitch);
    const startX = -((nx - 1) * pitch) / 2;
    const startZ = -((nz - 1) * pitch) / 2;
    const mesh = new THREE.InstancedMesh(geo, mat, nx * nz);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let ix = 0; ix < nx; ix++)
      for (let iz = 0; iz < nz; iz++) {
        m.makeTranslation(startX + ix * pitch, 0, startZ + iz * pitch);
        mesh.setMatrixAt(i++, m);
      }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  function buildCapacitors(matBody, matEnd, innerHalfX, innerHalfZ, outerHalfX, outerHalfZ) {
    const cw = 0.26, ch = 0.13, cd = 0.16;
    const bodyGeo = track(new THREE.BoxGeometry(cw, ch, cd));
    const capGeo = track(new THREE.BoxGeometry(cw * 0.18, ch * 1.02, cd));
    const placements = [];
    const rows = 2, gap = 0.34;
    const sides = [{ axis: 'x', sign: 1 }, { axis: 'x', sign: -1 }, { axis: 'z', sign: 1 }, { axis: 'z', sign: -1 }];
    for (const s of sides) {
      for (let rr = 0; rr < rows; rr++) {
        if (s.axis === 'x') {
          const x = s.sign * (innerHalfX + 0.25 + rr * gap);
          const span = innerHalfZ * 1.5;
          const n = Math.floor((span * 2) / gap);
          for (let k = 0; k < n; k++) {
            const z = -span + k * gap;
            if (Math.abs(z) > outerHalfZ - 0.25) continue;
            placements.push({ x, z, rot: 0 });
          }
        } else {
          const z = s.sign * (innerHalfZ + 0.25 + rr * gap);
          const span = innerHalfX * 1.5;
          const n = Math.floor((span * 2) / gap);
          for (let k = 0; k < n; k++) {
            const x = -span + k * gap;
            if (Math.abs(x) > outerHalfX - 0.25) continue;
            placements.push({ x, z, rot: Math.PI / 2 });
          }
        }
      }
    }
    const body = new THREE.InstancedMesh(bodyGeo, matBody, placements.length);
    const ends = new THREE.InstancedMesh(capGeo, matEnd, placements.length * 2);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3(1, 1, 1);
    let bi = 0, ei = 0;
    for (const p of placements) {
      e.set(0, p.rot, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(p.x, ch / 2, p.z), q, v);
      body.setMatrixAt(bi++, m);
      const ox = Math.cos(p.rot) * (cw * 0.41);
      const oz = -Math.sin(p.rot) * (cw * 0.41);
      m.compose(new THREE.Vector3(p.x + ox, ch / 2, p.z + oz), q, v);
      ends.setMatrixAt(ei++, m);
      m.compose(new THREE.Vector3(p.x - ox, ch / 2, p.z - oz), q, v);
      ends.setMatrixAt(ei++, m);
    }
    body.instanceMatrix.needsUpdate = true;
    ends.instanceMatrix.needsUpdate = true;
    const g = new THREE.Group();
    g.add(body, ends);
    return g;
  }

  function buildGoldRing(mat, w, d, ringW) {
    const shape = new THREE.Shape();
    const hx = w / 2, hz = d / 2;
    shape.moveTo(-hx, -hz); shape.lineTo(hx, -hz);
    shape.lineTo(hx, hz); shape.lineTo(-hx, hz); shape.lineTo(-hx, -hz);
    const hole = new THREE.Path();
    const ix = hx - ringW, iz = hz - ringW;
    hole.moveTo(-ix, -iz); hole.lineTo(-ix, iz);
    hole.lineTo(ix, iz); hole.lineTo(ix, -iz); hole.lineTo(-ix, -iz);
    shape.holes.push(hole);
    const geo = track(new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false }));
    geo.rotateX(-Math.PI / 2);
    return new THREE.Mesh(geo, mat);
  }

  // -------------------------------------------------------------------------
  // Master builder: data-center MCM accelerator, LIDLESS
  // Exploded layers: dies+HBM / interposer / substrate / BGA
  // -------------------------------------------------------------------------
  function buildPackage(mat) {
    const root = new THREE.Group();
    const layers = [];
    const W = 10.2, D = 9.6;

    // Substrate group (organic substrate + caps + gold ring + etch)
    const substrate = new THREE.Group();
    const subH = 0.55;
    const subBody = new THREE.Mesh(track(new RoundedBoxGeometry(W, subH, D, 4, 0.06)), mat.substrate);
    subBody.position.y = subH / 2;
    substrate.add(subBody);

    const interHalfX = (W * 0.78) / 2;
    const interHalfZ = (D * 0.78) / 2;
    const caps = buildCapacitors(mat.cap, mat.capEnd, interHalfX, interHalfZ, W / 2, D / 2);
    caps.position.y = subH;
    substrate.add(caps);

    const etchPlate = new THREE.Mesh(track(new THREE.PlaneGeometry(W * 0.30, W * 0.30)), mat.etch);
    etchPlate.rotation.x = -Math.PI / 2;
    etchPlate.position.set(-W * 0.30, subH + 0.004, D * 0.30);
    substrate.add(etchPlate);

    root.add(substrate);
    layers.push({ node: substrate, baseY: 0, explodeY: 0 });

    const subTop = subH;

    // BGA underside (separate explode layer, drops downward)
    const bga = buildBGA(mat.solder, W, D, 0.42);
    bga.position.y = 0;
    root.add(bga);
    layers.push({ node: bga, baseY: 0, explodeY: -2.6 });

    // Interposer group (silicon interposer + microbump field on top)
    const interposer = new THREE.Group();
    const interH = 0.20;
    const interW = W * 0.78, interD = D * 0.78;
    const interBody = new THREE.Mesh(track(new RoundedBoxGeometry(interW, interH, interD, 3, 0.04)), mat.interposer);
    interBody.position.y = interH / 2;
    interposer.add(interBody);

    const ring = buildGoldRing(mat.gold, interW * 0.96, interD * 0.96, 0.4);
    ring.position.y = interH + 0.002;
    interposer.add(ring);

    const bumps = buildMicrobumps(mat.microbump, interW * 0.62, interD * 0.78, 0.16, 0.05, interH + 0.01);
    interposer.add(bumps);

    interposer.position.y = subTop;
    root.add(interposer);
    layers.push({ node: interposer, baseY: subTop, explodeY: 2.4 });

    const interTop = subTop + interH;

    // Dies + HBM group (mirror-dark compute dies + HBM stacks)
    const diesHBM = new THREE.Group();
    const dieH = 0.30;
    const tw = 0.74, td = 0.92, gx = 0.07;
    const clusterCols = 2, clusterRows = 4;
    const clusterW = clusterCols * tw + (clusterCols - 1) * gx;
    // shared compute-die geometry across the cluster (disposed once)
    const dieGeo = track(new RoundedBoxGeometry(tw, dieH, td, 2, 0.02));
    for (let cx = 0; cx < clusterCols; cx++) {
      for (let cz = 0; cz < clusterRows; cz++) {
        const tile = new THREE.Mesh(dieGeo, mat.die);
        tile.position.set(
          (cx - (clusterCols - 1) / 2) * (tw + gx),
          dieH / 2,
          (cz - (clusterRows - 1) / 2) * (td + gx));
        diesHBM.add(tile);
      }
    }

    const hbmW = 1.5, hbmD = 1.9, hbmH = 0.62;
    const hbmOffX = clusterW / 2 + hbmW / 2 + 0.35;
    const hbmGeo = track(new RoundedBoxGeometry(hbmW, hbmH, hbmD, 2, 0.03));
    const hbmZpos = [];
    const zCount = 2;
    for (let i = 0; i < zCount; i++) hbmZpos.push((i - (zCount - 1) / 2) * (hbmD + 0.3));
    for (const sx of [-hbmOffX, hbmOffX]) {
      for (const sz of hbmZpos) {
        const stack = new THREE.Mesh(hbmGeo, mat.hbm);
        stack.position.set(sx, hbmH / 2, sz);
        diesHBM.add(stack);
      }
    }

    diesHBM.position.y = interTop + 0.02;
    root.add(diesHBM);
    layers.push({ node: diesHBM, baseY: interTop + 0.02, explodeY: 4.2 });

    // recentre stack vertically for tidy orbit
    root.position.y = -(interTop) * 0.6;

    return { group: root, layers };
  }

  const tex = {
    interposer: makeInterposerTex({ size: 512 }),
    die: makeSiliconDie({ size: 512 }),
    hbm: makeHBMTex({ size: 256 }),
    substrate: makeSubstrateTex({ size: 512 }),
    bga: makeBGAField({ size: 512, cols: 26 }),
    etch: makeEtchTexture({ size: 512 }),
  };
  const mat = makeMaterials(tex);
  const { group, layers } = buildPackage(mat);
  scene.add(group);

  // -------------------------------------------------------------------------
  // Explode application + framing (camera driven here, no OrbitControls)
  // -------------------------------------------------------------------------
  function applyLayers(f) {
    for (const L of layers) L.node.position.y = L.baseY + L.explodeY * f;
  }

  // Drag-to-rotate accumulators layered on top of the auto loop. Yaw is
  // effectively unbounded; pitch is clamped. velYaw/velPitch carry inertia.
  const PITCH_LIMIT = 0.5;
  let dragYaw = 0, dragPitch = 0;
  let velYaw = 0, velPitch = 0;
  let dragging = false, draggingId = null, lastX = 0, lastY = 0;

  function renderFrame(sep, spin) {
    applyLayers(sep);

    // Auto spin/pitch with the user's drag accumulators layered on top.
    group.rotation.y = spin + dragYaw;
    group.rotation.x = -0.32 + sep * 0.05 + dragPitch;

    // Pull the camera back as the package separates so it stays framed.
    const camR = 17 + sep * 4.0;
    const ang = 0.86;
    camera.position.set(Math.cos(ang) * camR * 0.62, 7.5 + sep * 3.0, Math.sin(ang) * camR);
    camera.lookAt(0, 0.4 + sep * 0.6, 0);

    renderer.render(scene, camera);
  }

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------
  function resize() {
    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(() => { resize(); if (reduced) renderFrame(0.32, 0.5); else ensureRunning(); });
  ro.observe(mount);

  // -------------------------------------------------------------------------
  // Hover state from parent card
  // -------------------------------------------------------------------------
  const card = mount.closest('.proj-card') || mount;
  let hover = 0, hoverTarget = 0, active = false;
  const onEnter = () => { hoverTarget = 1; if (active) ensureRunning(); };
  const onLeave = () => { hoverTarget = 0; if (active) ensureRunning(); };
  if (!reduced) {
    card.addEventListener('pointerenter', onEnter);
    card.addEventListener('pointerleave', onLeave);
  }

  // -------------------------------------------------------------------------
  // Click-and-drag rotation (pointer events -> mouse + touch). Drag adds yaw
  // and clamped pitch on top of the auto loop; release leaves inertia behind.
  // -------------------------------------------------------------------------
  const DRAG_SENS = 0.008; // radians per pixel
  const canvasEl = renderer.domElement;

  const onPointerDown = e => {
    if (dragging) return;
    dragging = true;
    draggingId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    velYaw = 0; velPitch = 0;
    canvasEl.style.cursor = 'grabbing';
    try { canvasEl.setPointerCapture(e.pointerId); } catch (_) {}
    if (active) ensureRunning();
    e.preventDefault();
  };

  const onPointerMove = e => {
    if (!dragging || e.pointerId !== draggingId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const dYaw = dx * DRAG_SENS;
    const dPitch = dy * DRAG_SENS;
    dragYaw += dYaw;
    dragPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, dragPitch + dPitch));
    // remember the last motion so release can hand off to inertia
    velYaw = dYaw;
    velPitch = dPitch;
    if (active) ensureRunning();
    e.preventDefault();
  };

  const endDrag = e => {
    if (!dragging || (e && e.pointerId !== draggingId)) return;
    dragging = false;
    const id = draggingId;
    draggingId = null;
    canvasEl.style.cursor = 'grab';
    if (id !== null) { try { canvasEl.releasePointerCapture(id); } catch (_) {} }
    // inertia continues to be applied by the tick loop until it decays
    if (active) ensureRunning();
  };

  if (!reduced) {
    canvasEl.style.cursor = 'grab';
    canvasEl.style.touchAction = 'none';
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', endDrag);
    canvasEl.addEventListener('pointercancel', endDrag);
  }

  // -------------------------------------------------------------------------
  // Context-loss guard (GPU reset invalidates the PMREM env map)
  // -------------------------------------------------------------------------
  const onLost = e => { e.preventDefault(); running = false; };
  const onRestored = () => {
    const oldEnv = envTex;
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    if (oldEnv) oldEnv.dispose();
    resize();
    if (reduced) renderFrame(0.32, 0.5);
    else if (active) ensureRunning();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  // -------------------------------------------------------------------------
  // Continuous auto explode/reassemble loop driven by a slow phase
  // -------------------------------------------------------------------------
  const PERIOD = 11000; // ms for one explode+reassemble cycle
  let running = false, raf = 0, startT = 0, phaseAtStop = 0;

  function tick(now) {
    if (!running) return;
    const phase = phaseAtStop + (now - startT) / PERIOD;
    // triangle wave 0..1..0 with a gentle hold via easeInOut
    const tri = 1 - Math.abs((phase % 2) - 1);
    const auto = easeInOut(tri);
    hover += (hoverTarget - hover) * 0.08;
    // hover nudges the package a little further open
    const sep = Math.min(1, auto * 0.92 + hover * 0.12);
    // spin slowly, accelerating slightly on hover
    const spin = phase * 0.55 * (1 + hover * 0.6);
    // Drag inertia: while not dragging, ease the residual velocity out and
    // let it decay so the RAF settles back to the plain auto loop.
    if (!dragging) {
      if (velYaw !== 0 || velPitch !== 0) {
        dragYaw += velYaw;
        dragPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, dragPitch + velPitch));
        velYaw *= 0.92;
        velPitch *= 0.92;
        if (Math.abs(velYaw) < 1e-4) velYaw = 0;
        if (Math.abs(velPitch) < 1e-4) velPitch = 0;
      }
    }
    renderFrame(sep, spin);
    raf = requestAnimationFrame(tick);
  }

  function ensureRunning() {
    if (reduced || running) return;
    running = true;
    startT = performance.now();
    raf = requestAnimationFrame(tick);
  }

  resize();

  return {
    start() {
      active = true;
      resize();
      if (reduced) {
        requestAnimationFrame(() => renderFrame(0.32, 0.5));
        return;
      }
      ensureRunning();
    },
    stop() {
      active = false;
      if (!running) return;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      phaseAtStop = phaseAtStop + (performance.now() - startT) / PERIOD;
    },
    dispose() {
      this.stop();
      ro.disconnect();
      card.removeEventListener('pointerenter', onEnter);
      card.removeEventListener('pointerleave', onLeave);
      // release pointer capture if teardown lands mid-drag, then remove drag listeners
      if (dragging && draggingId !== null) {
        try { canvasEl.releasePointerCapture(draggingId); } catch (_) {}
      }
      dragging = false;
      draggingId = null;
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerup', endDrag);
      canvasEl.removeEventListener('pointercancel', endDrag);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      disposables.forEach(d => d && d.dispose && d.dispose());
      if (envTex) envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
