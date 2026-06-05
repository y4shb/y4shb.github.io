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

// Liquid-cooled data-center GPU accelerator in the OAM (OCP Accelerator Module)
// form factor: a roughly square baseboard carrying a large central compute package
// (metal IHS over an organic substrate) ringed by HBM memory stacks, mounting
// standoffs/screws, and a nickel/aluminium cold plate, with a transparent coolant
// loop carrying a glowing oxide-red flow (TRON-like). Original representation of the
// generic OAM hardware class - no logos, wordmarks, or proprietary trade dress.
// Cursor orbits/tilts the module and speeds the coolant; scroll rotates it on touch.
// Self-contained init(mount,ctx) -> {start,stop,dispose}; on-demand RAF,
// reduced-motion static frame, context-loss guard.

const OXIDE = '#d64545';
const lerp = (a, b, t) => a + (b - a) * t;

// Merged cinematic grade (one full-screen pass, linear space, BEFORE OutputPass so ACES
// stays the single tone-map/colorspace step - no double tone-mapping). Folds four product-shot
// effects into one pass to avoid per-pass render-target bandwidth:
//   - chromatic aberration: scales with radius^2 so the centre stays razor-sharp and only the
//     corners fringe, exactly how a real lens behaves (cheap glitch look avoided).
//   - subtle radial defocus: a faint screen-space blur that ramps in at the edges only - fakes a
//     shallow product-shot focal plane (crisp centre, soft corners) at ~0 cost vs a real BokehPass
//     depth prepass, which the small-card budget can't spare.
//   - vignette: soft round corner darkening, floored so corners never crush to black.
//   - film grain: animated sensor-style noise, the strongest "photo not render" tell; kept subtle
//     and weighted toward the shadows/edges. Frozen under reduced motion (uTime never advances).
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel:   { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uTime:    { value: 0 },
    uAberr:   { value: 0.0006 },
    uVig:     { value: 1.05 },
    uVigSoft: { value: 0.62 },
    uGrain:   { value: 0.012 },
    uDof:     { value: 0.0 },   // edge-defocus off: it shimmered on rotation and softened detail
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uTime,uAberr,uVig,uVigSoft,uGrain,uDof; varying vec2 vUv;',
    'float hash(vec2 p){ p = fract(p * vec2(123.34,456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'void main(){',
    '  vec2 d = vUv - 0.5; float r2 = dot(d, d);',          // squared radial distance from centre
    '  vec2 off = d * uAberr * r2 * 4.0;',                  // CA fringes corners only
    '  float cr = texture2D(tDiffuse, vUv - off).r;',
    '  vec4  cg = texture2D(tDiffuse, vUv);',
    '  float cb = texture2D(tDiffuse, vUv + off).b;',
    '  vec3 col = vec3(cr, cg.g, cb);',
    '  float blur = smoothstep(0.12, 0.5, r2) * uDof;',     // 0 in centre, ramps in toward corners
    '  if (blur > 0.001) {',
    '    vec3 b = col;',
    '    b += texture2D(tDiffuse, vUv + vec2( uTexel.x, 0.0) * 1.5).rgb;',
    '    b += texture2D(tDiffuse, vUv + vec2(-uTexel.x, 0.0) * 1.5).rgb;',
    '    b += texture2D(tDiffuse, vUv + vec2(0.0,  uTexel.y) * 1.5).rgb;',
    '    b += texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y) * 1.5).rgb;',
    '    col = mix(col, b / 5.0, blur * 0.7);',
    '  }',
    '  float vig = smoothstep(0.0, uVigSoft, 1.0 - r2 * uVig);',
    '  col *= mix(0.8, 1.0, vig);',                          // corners darken at most ~20%
    '  float g = hash(vUv * vec2(1920.0, 1080.0) + uTime) - 0.5;',
    '  col += g * uGrain * (0.6 + 0.4 * (1.0 - vig));',      // grain stronger in shadow/edge
    '  gl_FragColor = vec4(col, cg.a);',
    '}',
  ].join('\n'),
};

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);
  const noHover = !matchMedia('(hover: hover)').matches;

  // ---- renderer ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0a0a0a, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.62;   // dialed down: the enhanced metals were clipping to white
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab';
  mount.appendChild(renderer.domElement);
  const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.set(0, 7.6, 5.4);   // higher, more top-down so the square module reads as a square, not a strip
  camera.lookAt(0, -0.3, 0);          // aim at the module's true centroid (board sits at y -0.55 + stack height)

  const pmrem = new THREE.PMREMGenerator(renderer);
  // crisper IBL: low blur (0.02) keeps tight specular streaks on the brushed metal + glass tube,
  // which a dark scene leans on for shape - IBL is baked once, so sharper costs nothing per frame.
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
  scene.environment = envTex;

  // 3-point rig, single oxide-red rim is the only chromatic light. Tuned darker/cinematic:
  // a hotter, higher key for crisp metal speculars; a dimmer cool fill so shadow sides stay
  // moody rather than flat; the oxide rim grazes the back edge to detach the board from #0a0a0a.
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 11, 6);
  const fill = new THREE.DirectionalLight(0x9fb6e0, 0.38); fill.position.set(-8, 3.5, 5);
  const rim = new THREE.DirectionalLight(0xd64545, 1.05); rim.position.set(-5, 5, -9);
  // faint top kicker (neutral) to put a thin gloss line along the IHS lid + cold-plate crests
  const kick = new THREE.DirectionalLight(0xcfd6de, 0.26); kick.position.set(0, 12, -2);
  scene.add(key, fill, rim, kick, new THREE.AmbientLight(0x20242a, 0.22)); // lower ambient = deeper crevices

  const disposables = [];
  const track = o => { disposables.push(o); return o; };

  // ---- procedural PCB texture (dark teal solder mask + copper traces + pads) ----
  function mulberry32(s) {
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makePCBTex(size = 1024) {
    const rng = mulberry32(7);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#0c1714'); g.addColorStop(0.5, '#0f1d18'); g.addColorStop(1, '#0a1410');
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    // copper trace bundles
    x.lineCap = 'round';
    for (let i = 0; i < 130; i++) {
      x.strokeStyle = `rgba(${120 + rng() * 40 | 0},${80 + rng() * 30 | 0},40,${0.10 + rng() * 0.10})`;
      x.lineWidth = rng() < 0.25 ? 3 : 1.4;
      let px = rng() * size, py = rng() * size;
      x.beginPath(); x.moveTo(px, py);
      const segs = 3 + (rng() * 5 | 0);
      for (let s = 0; s < segs; s++) {
        if (rng() < 0.5) px += (rng() < 0.5 ? -1 : 1) * (40 + rng() * 200);
        else py += (rng() < 0.5 ? -1 : 1) * (40 + rng() * 200);
        x.lineTo(px, py);
      }
      x.stroke();
    }
    // vias + pads
    for (let i = 0; i < 700; i++) {
      const vx = rng() * size, vy = rng() * size, r = 1 + rng() * 2.2;
      x.fillStyle = 'rgba(150,110,55,0.30)'; x.beginPath(); x.arc(vx, vy, r, 0, 7); x.fill();
      x.fillStyle = 'rgba(6,10,8,0.9)'; x.beginPath(); x.arc(vx, vy, r * 0.45, 0, 7); x.fill();
    }
    // silkscreen refs: generic invented part designators + a fake lot code (NO branding)
    x.fillStyle = 'rgba(190,200,196,0.5)'; x.font = '13px monospace';
    const refs = ['U1', 'L4', 'C12', 'Q3', 'R20', 'VRM', 'PH', 'TP1', 'J7', 'HBM0', 'HBM3'];
    for (let i = 0; i < 30; i++) x.fillText(refs[(rng() * refs.length) | 0], rng() * size, rng() * size);
    x.fillStyle = 'rgba(170,180,176,0.55)'; x.font = 'bold 18px monospace';
    x.fillText('ACCELERATOR', size * 0.12, size * 0.94);
    x.font = '12px monospace';
    x.fillText('OAM  LOT 7F-2241  REV C', size * 0.12, size * 0.97);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = MAX_ANISO; t.needsUpdate = true;
    return track(t);
  }

  // ---- brushed-metal micro grain (data map: keep LinearSRGB, NOT sRGB) ----
  function makeBrushTex(size = 512) {
    const rng = mulberry32(23);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = '#808080'; x.fillRect(0, 0, size, size);   // neutral roughness mid
    for (let i = 0; i < 2600; i++) {
      const v = 96 + (rng() * 64 | 0);                       // streak brightness
      x.strokeStyle = `rgb(${v},${v},${v})`;
      x.lineWidth = rng() < 0.3 ? 1.5 : 0.6;
      const px = rng() * size;
      x.beginPath(); x.moveTo(px, 0); x.lineTo(px + (rng() - 0.5) * 4, size); x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4);
    t.anisotropy = MAX_ANISO; t.needsUpdate = true;
    // leave colorSpace default (LinearSRGB): this is a data map
    return track(t);
  }
  // faint longitudinal normal grain for the glass tube wall (refraction ripple)
  function makeTubeNormalTex(size = 256) {
    const rng = mulberry32(19);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = '#8080ff'; x.fillRect(0, 0, size, size);   // flat normal
    for (let i = 0; i < 60; i++) {
      const px = rng() * size;
      x.strokeStyle = `rgba(${120 + (rng() * 16 | 0)},${120 + (rng() * 16 | 0)},255,0.5)`;
      x.lineWidth = 0.6 + rng() * 1.2;
      x.beginPath(); x.moveTo(px, 0); x.lineTo(px + (rng() - 0.5) * 8, size); x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 1);
    t.anisotropy = MAX_ANISO; t.needsUpdate = true;
    return track(t);
  }

  // soft radial contact-shadow blob (grounds the board against the dark stage; static, zero
  // per-frame cost, works in the reduced-motion path). Feathered hard so the edge never reads
  // as a disc; parented to the scene (not the board) so it stays put while the board orbits.
  function makeShadowTex(size = 256) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0.0)');
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true;
    return track(t);
  }

  // ---- materials ----
  const brushTex = makeBrushTex();
  const pcbMat = new THREE.MeshPhysicalMaterial({
    map: makePCBTex(), color: 0x12241d, metalness: 0.35, roughness: 0.42,
    clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 0.9,
    sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x16302a), // soft solder-mask grazing glow
  });
  // cold-plate base: satin electroless-nickel read (matte, not chrome), also the fitting collars
  const aluDark = new THREE.MeshPhysicalMaterial({
    color: 0x7a7f86, metalness: 1.0, roughness: 0.58,
    roughnessMap: brushTex, anisotropy: 0, anisotropyRotation: 0,
    clearcoat: 0, clearcoatRoughness: 0.35, envMapIntensity: 0.4,
  });
  const screwMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.55, anisotropy: 0, envMapIntensity: 0.5 }); // turned-metal standoff/screw
  const mosMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, metalness: 0.35, roughness: 0.45, envMapIntensity: 0.7 });           // dark DrMOS power stage
  const sockMat = new THREE.MeshPhysicalMaterial({ color: 0x2a2d31, metalness: 1.0, roughness: 0.5, envMapIntensity: 0.7 });            // recessed hex socket
  const backMat = new THREE.MeshPhysicalMaterial({ color: 0x202327, metalness: 1.0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, envMapIntensity: 0.9 }); // anodized backplate
  const barbMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.5, anisotropy: 0, envMapIntensity: 0.5 }); // nickel barb fitting
  // --- OAM module materials ---
  // HBM stack: molded grey epoxy top, matte (no clearcoat) so the ring of stacks reads as
  // dark silicon packaging, not glossy plastic; very low envMap keeps it from glittering.
  const hbmMat = new THREE.MeshPhysicalMaterial({ color: 0x3c4046, metalness: 0.18, roughness: 0.62, clearcoat: 0, envMapIntensity: 0.35 });
  // central package IHS: brushed nickel-plated copper heat-spreader lid (warmer, satin), the hero metal
  const ihsMat = new THREE.MeshPhysicalMaterial({
    color: 0xb4b0a8, metalness: 1.0, roughness: 0.46,
    roughnessMap: brushTex, normalMap: brushTex, normalScale: new THREE.Vector2(0.10, 0.10),
    anisotropy: 0, clearcoat: 0, envMapIntensity: 0.45,
  });
  // package substrate: organic laminate, dark green-black, matte (the die sits on this square)
  const subMat = new THREE.MeshPhysicalMaterial({ color: 0x10231c, metalness: 0.2, roughness: 0.58, clearcoat: 0.25, clearcoatRoughness: 0.35, envMapIntensity: 0.7 });
  // sparing gold/copper: capacitor/contact accents around the package (used very sparingly)
  const goldAccent = new THREE.MeshPhysicalMaterial({ color: 0xc89a52, metalness: 1.0, roughness: 0.5, anisotropy: 0, envMapIntensity: 0.45 });
  // tiny status LED (the one other place oxide-red is allowed): emissive, blooms faintly
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x2a0c0c, emissive: new THREE.Color(OXIDE), emissiveIntensity: 2.2, roughness: 0.4, metalness: 0 });
  [pcbMat, aluDark, screwMat, mosMat, sockMat, backMat, barbMat,
   hbmMat, ihsMat, subMat, goldAccent, ledMat].forEach(track);

  // ---- OAM module assembly (roughly square baseboard) ----
  const board = new THREE.Group();
  const W = 5.4, D = 5.0, pcbH = 0.22;   // square-ish baseboard footprint
  const cx0 = 0, cz0 = 0;                 // module centre (package + HBM ring centre)
  const m4 = new THREE.Matrix4();

  // dark substrate baseboard (the OAM carrier card)
  const pcb = new THREE.Mesh(track(new RoundedBoxGeometry(W, pcbH, D, 3, 0.06)), pcbMat);
  pcb.position.y = pcbH / 2;
  board.add(pcb);

  // ---- central compute package: organic substrate square + metal IHS heat-spreader lid ----
  const subSize = 1.9, lidSize = 1.5;
  const subY = pcbH + 0.05;
  const substrate = new THREE.Mesh(track(new RoundedBoxGeometry(subSize, 0.10, subSize, 2, 0.03)), subMat);
  substrate.position.set(cx0, subY, cz0);
  board.add(substrate);
  const lid = new THREE.Mesh(track(new RoundedBoxGeometry(lidSize, 0.14, lidSize, 2, 0.035)), ihsMat);
  const lidY = subY + 0.12;
  lid.position.set(cx0, lidY, cz0);
  board.add(lid);
  // shallow bevel-step ridge: a thin inset top plate on the IHS to catch a gloss highlight
  const lidTop = new THREE.Mesh(track(new RoundedBoxGeometry(lidSize * 0.82, 0.04, lidSize * 0.82, 2, 0.03)), ihsMat);
  lidTop.position.set(cx0, lidY + 0.09, cz0);
  board.add(lidTop);

  // ---- HBM ring: stacks of molded grey memory arranged immediately around the die ----
  // signature data-center-accelerator look. InstancedMesh; deterministic micro-jitter so the
  // ring reads as placed parts, not a stamped pattern.
  const hbmGeo = track(new THREE.BoxGeometry(0.62, 0.20, 0.46));
  const hbmRng = mulberry32(31);
  const hbmRing = 1.42;            // radius of the HBM ring from package centre
  // 8 stacks: 2 per side of the square package (the classic OAM HBM layout)
  const hbmSpec = [];
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < 2; k++) {
      const along = (k - 0.5) * 0.78;     // two stacks per side, offset from centre
      let px, pz, rot;
      if (side === 0) { px = cx0 + along; pz = cz0 - hbmRing; rot = 0; }
      else if (side === 1) { px = cx0 + along; pz = cz0 + hbmRing; rot = 0; }
      else if (side === 2) { px = cx0 - hbmRing; pz = cz0 + along; rot = Math.PI / 2; }
      else { px = cx0 + hbmRing; pz = cz0 + along; rot = Math.PI / 2; }
      hbmSpec.push([px, pz, rot]);
    }
  }
  const hbm = new THREE.InstancedMesh(hbmGeo, hbmMat, hbmSpec.length);
  const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _hs = new THREE.Vector3(1, 1, 1);
  const _yAxis = new THREE.Vector3(0, 1, 0);
  hbmSpec.forEach((s, i) => {
    _hp.set(s[0], subY + 0.10 + hbmRng() * 0.01, s[1]);
    _hq.setFromAxisAngle(_yAxis, s[2]);
    m4.compose(_hp, _hq, _hs);
    hbm.setMatrixAt(i, m4);
  });
  hbm.instanceMatrix.needsUpdate = true;
  board.add(hbm);

  // ---- mounting standoffs/screws at the four corners of the substrate ----
  const standoffGeo = track(new THREE.CylinderGeometry(0.16, 0.16, 0.18, 18));
  const screwGeo = track(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 14));
  const mp = subSize / 2 + 0.32;
  const screwPos = [[cx0 - mp, cz0 - mp], [cx0 + mp, cz0 - mp], [cx0 - mp, cz0 + mp], [cx0 + mp, cz0 + mp]];
  const standoffs = new THREE.InstancedMesh(standoffGeo, screwMat, screwPos.length);
  screwPos.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.09, p[1]); standoffs.setMatrixAt(i, m4); });
  standoffs.instanceMatrix.needsUpdate = true;
  board.add(standoffs);
  const screws = new THREE.InstancedMesh(screwGeo, screwMat, screwPos.length);
  screwPos.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.22, p[1]); screws.setMatrixAt(i, m4); });
  screws.instanceMatrix.needsUpdate = true;
  board.add(screws);
  // recessed hex (Allen) socket sunk into each screw head
  const sockGeo = track(new THREE.CylinderGeometry(0.058, 0.058, 0.05, 6));
  const sockets = new THREE.InstancedMesh(sockGeo, sockMat, screwPos.length);
  screwPos.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.25, p[1]); sockets.setMatrixAt(i, m4); });
  sockets.instanceMatrix.needsUpdate = true;
  board.add(sockets);

  // ---- sparing gold decoupling-cap accents flanking the package (used very sparingly) ----
  const capGeo = track(new THREE.BoxGeometry(0.16, 0.06, 0.10));
  const capRng = mulberry32(11);
  const capSpec = [];
  for (let i = 0; i < 6; i++) capSpec.push([cx0 - subSize / 2 - 0.18, cz0 - 0.7 + i * 0.28]);
  for (let i = 0; i < 6; i++) capSpec.push([cx0 + subSize / 2 + 0.18, cz0 - 0.7 + i * 0.28]);
  const caps = new THREE.InstancedMesh(capGeo, goldAccent, capSpec.length);
  capSpec.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.03 + capRng() * 0.005, p[1]); caps.setMatrixAt(i, m4); });
  caps.instanceMatrix.needsUpdate = true;
  board.add(caps);

  // ---- low VRM ridge along one baseboard edge (dark DrMOS row, keeps the corner busy) ----
  const mosGeo = track(new THREE.BoxGeometry(0.22, 0.07, 0.22));
  const mosN = 10;
  const mos = new THREE.InstancedMesh(mosGeo, mosMat, mosN);
  for (let i = 0; i < mosN; i++) { m4.makeTranslation(cx0 - W / 2 + 0.55 + i * 0.4, pcbH + 0.035, cz0 + D / 2 - 0.4); mos.setMatrixAt(i, m4); }
  mos.instanceMatrix.needsUpdate = true;
  board.add(mos);

  // ---- tiny oxide-red status LED near a corner (the only non-coolant oxide accent) ----
  const led = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.04, 0.05)), ledMat);
  led.position.set(cx0 + W / 2 - 0.45, pcbH + 0.025, cz0 + D / 2 - 0.45);
  board.add(led);

  // ---- anodized backplate: closes the underside (visible once orbited 360) ----
  const backplate = new THREE.Mesh(track(new RoundedBoxGeometry(W * 0.98, 0.06, D * 0.98, 2, 0.04)), backMat);
  backplate.position.y = -0.04;
  board.add(backplate);

  // ---- nickel/aluminium cold plate seating over the package ----
  // square plate covering the package + inner HBM ring, with a low surround lip.
  const plateW = subSize + 0.9, plateD = subSize + 0.9, plateBaseH = 0.16;
  const plateBaseY = lidY + 0.16 + plateBaseH / 2;
  const coldBase = new THREE.Mesh(track(new RoundedBoxGeometry(plateW, plateBaseH, plateD, 2, 0.04)), aluDark);
  coldBase.position.set(cx0, plateBaseY, cz0);
  board.add(coldBase);
  // raised perimeter lip so the plate reads as a milled coolant block, not a flat slab
  const coldLip = new THREE.Mesh(track(new RoundedBoxGeometry(plateW, 0.10, plateD, 2, 0.04)), aluDark);
  coldLip.position.set(cx0, plateBaseY + plateBaseH / 2 + 0.05, cz0);
  board.add(coldLip);
  const plateTop = plateBaseY + plateBaseH / 2 + 0.10;

  // ---- coolant loop: glass tube + glowing inner flow core (UNCHANGED material/shader,
  // repositioned to sit cleanly over the square cold plate) ----
  const lr = plateW / 2 - 0.28;                  // loop radius over the plate
  const ly = plateTop + 0.16;                    // sit just above the cold plate lip
  const pts = [
    new THREE.Vector3(cx0 - lr, ly, cz0 - lr),
    new THREE.Vector3(cx0 + lr, ly, cz0 - lr),
    new THREE.Vector3(cx0 + lr + 0.45, ly - 0.18, cz0),
    new THREE.Vector3(cx0 + lr, ly, cz0 + lr),
    new THREE.Vector3(cx0 - lr, ly, cz0 + lr),
    new THREE.Vector3(cx0 - lr - 0.45, ly - 0.18, cz0),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
  const tubeOuter = track(new THREE.TubeGeometry(curve, 220, 0.17, 16, true));
  const tubeInner = track(new THREE.TubeGeometry(curve, 220, 0.11, 14, true));

  // borosilicate coolant tube: white base lets transmission/attenuation tint (a dark
  // base reads muddy); iridescence is the r160-safe stand-in for dispersion (added r164).
  const glassMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.05,
    transmission: 1.0, ior: 1.46, thickness: 0.34,
    attenuationColor: new THREE.Color(0x9fb2b8),   // faint cool-neutral wall tint (oxide stays exclusive to flow)
    attenuationDistance: 1.4,                       // > thickness → clear centre, faint edges
    iridescence: 0.25, iridescenceIOR: 1.3, iridescenceThicknessRange: [120, 380],
    clearcoat: 1.0, clearcoatRoughness: 0.03, envMapIntensity: 1.15,
    transparent: true, depthWrite: false,           // glass must not occlude the inner core
  }));
  glassMat.normalMap = makeTubeNormalTex();
  glassMat.normalScale = new THREE.Vector2(0.06, 0.06); // tiny: refraction ripple, not frosted
  const flowMat = track(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSpeed: { value: 0.6 }, uColor: { value: new THREE.Color(OXIDE) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform float uTime; uniform float uSpeed; uniform vec3 uColor; varying vec2 vUv;',
      'void main(){',
      '  float n = 16.0;',
      '  float f = fract(vUv.x * n - uTime * uSpeed);',
      '  float pulse = smoothstep(0.0, 0.16, f) * (1.0 - smoothstep(0.32, 0.9, f));',
      '  float a = 0.22 + pulse * 1.25;',
      '  gl_FragColor = vec4(uColor * a * 2.3, a);',
      '}',
    ].join('\n'),
  }));
  const flowCore = new THREE.Mesh(tubeInner, flowMat);
  const glassTube = new THREE.Mesh(tubeOuter, glassMat);
  flowCore.renderOrder = 1;   // glowing core draws first
  glassTube.renderOrder = 2;  // glass wall draws after (with depthWrite:false) so the core reads through
  board.add(flowCore, glassTube);

  // ---- compression fittings: knurled collar + stepped barb where the tube meets
  // the plate at the two side lobes, oriented to the curve tangent so they plumb in.
  const collarGeo = track(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 24));
  const barbGeo = track(new THREE.CylinderGeometry(0.15, 0.18, 0.16, 20));
  const _ft = new THREE.Vector3(), _fp = new THREE.Vector3();
  const _yUp = new THREE.Vector3(0, 1, 0), _fq = new THREE.Quaternion();
  [2 / 6, 5 / 6].forEach(u => {                 // pts[2] and pts[5] side lobes
    curve.getPointAt(u, _fp);
    curve.getTangentAt(u, _ft);
    _fq.setFromUnitVectors(_yUp, _ft.normalize()); // align cylinder axis to tube tangent
    const collar = new THREE.Mesh(collarGeo, aluDark);
    collar.position.copy(_fp); collar.quaternion.copy(_fq);
    const barb = new THREE.Mesh(barbGeo, barbMat);
    barb.position.copy(_fp).addScaledVector(_ft, 0.15); barb.quaternion.copy(_fq);
    board.add(collar, barb);
  });

  // rest pose + recentre: top-leaning 3/4 view of the square module
  board.rotation.x = -0.5;
  board.rotation.y = -0.62;
  board.position.y = -0.55;
  scene.add(board);

  // grounded contact shadow under the module (square footprint → near-square blob)
  const shadowMat = track(new THREE.MeshBasicMaterial({
    map: makeShadowTex(), transparent: true, depthWrite: false, opacity: 0.9, color: 0x000000,
  }));
  const shadowPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(W * 1.9, D * 1.9)), shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = -1.7;    // below the module's lowest swept point so it reads as cast, not stuck
  shadowPlane.renderOrder = -1;     // draw before the board
  scene.add(shadowPlane);           // child of scene, not board → stays grounded as the board orbits

  // ---- postprocessing (GTAO occlusion → bloom → cinematic grade → SMAA → ACES output) ----
  let composer, bloom, gtao, grade, smaa, output;
  function buildComposer(w, h) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { samples: 4 }));
    composer.addPass(new RenderPass(scene, camera));
    // GTAO darkens the gaps between the HBM ring and the package, the crevices under the cold plate,
    // and where standoffs/components meet the substrate: the #1 cue that sells a machined assembly
    // (PBR metal looks plasticky with no occlusion in the gaps the env map floods). Skip on
    // touch/low-power (noHover) to protect that budget. Goes BEFORE bloom so occluded areas don't bloom.
    if (!noHover) {
      gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;   // beauty * denoised AO (ship this; .AO/.Denoise are debug views)
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({
        radius: 0.45,           // world units, square module ~5 wide; reaches the HBM/package gaps + component bases
        distanceExponent: 1.0,
        thickness: 0.5,         // chunkier parts than the old thin fins: a touch more thickness reads cleaner
        distanceFallOff: 0.6,
        scale: 1.1,
        samples: 16,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 2, rings: 2, samples: 8 });
      composer.addPass(gtao);
    }
    // With GTAO darkening crevices, tighten bloom (higher threshold) so only the coolant core blooms,
    // not the brighter metal speculars from the hotter key.
    bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.3, 0.45, 0.95);
    composer.addPass(bloom);
    // cinematic grade (vignette + chromatic aberration + edge-defocus + grain), linear space,
    // after bloom so the glow is part of what gets graded, before SMAA + OutputPass.
    grade = new ShaderPass(GradeShader);
    grade.uniforms.uTexel.value.set(1 / w, 1 / h);
    if (reduced) grade.uniforms.uGrain.value = 0;   // no animated grain on the reduced-motion static frame
    composer.addPass(grade);
    // SMAA: the composer bypasses the renderer's MSAA, so fin/finger/bracket edges alias on the
    // offscreen target once GTAO/bloom run; SMAA restores clean edges cheaply (one pass).
    smaa = new SMAAPass(w, h);
    composer.addPass(smaa);
    output = new OutputPass();            // ACES tone-map + sRGB, always last (single tone-map step)
    composer.addPass(output);
  }

  // ---- sizing ----
  function size() {
    const w = Math.max(1, mount.clientWidth), h = Math.max(1, mount.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!composer) buildComposer(w * dpr, h * dpr);
    else {
      composer.setSize(w * dpr, h * dpr);   // propagates to every pass (GTAO/bloom/grade/SMAA/output)
      if (gtao) gtao.setSize(w * dpr, h * dpr);
      if (grade) grade.uniforms.uTexel.value.set(1 / (w * dpr), 1 / (h * dpr));   // keep edge-blur tap size correct
    }
  }

  // ---- interaction state ----
  let tx = 0, ty = 0, cx = 0, cy = 0;   // pointer target / current (parallax orbit)
  let spin = -0.62, scrollSpin = 0;      // start at the rest diagonal yaw; idle drift from there
  let flow = 0.6, flowTarget = 0.6;      // coolant speed
  let bloomBoost = 0, bloomTarget = 0;
  let dragging = false, dragYaw = 0, dragPitch = 0, vel = 0, lastX = 0, lastY = 0;  // click-drag 360 orbit

  function onMove(e) {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      dragYaw += dx * 0.01;
      dragPitch = Math.max(-0.5, Math.min(0.5, dragPitch + dy * 0.006));
      vel = dx * 0.01;
      flowTarget = 1.9; bloomTarget = 1;
      ensure();
      return;
    }
    const r = mount.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    flowTarget = 1.9; bloomTarget = 1;
    ensure();
  }
  function onLeave() { if (!dragging) { tx = 0; ty = 0; flowTarget = 0.6; bloomTarget = 0; ensure(); } }
  function onDown(e) {
    dragging = true; lastX = e.clientX; lastY = e.clientY; vel = 0;
    renderer.domElement.style.cursor = 'grabbing';
    try { mount.setPointerCapture(e.pointerId); } catch (_) {}
    ensure();
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    renderer.domElement.style.cursor = 'grab';
    try { mount.releasePointerCapture(e.pointerId); } catch (_) {}
    ensure();
  }
  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const r = mount.getBoundingClientRect();
      const prog = 1 - (r.top + r.height / 2) / (window.innerHeight + r.height);
      scrollSpin = (prog - 0.5) * 2.2;
      if (noHover) { flowTarget = 1.4; bloomTarget = 0.7; }
      ensure();
    });
  }

  // ---- render + loop ----
  function frame() {
    cx = lerp(cx, tx, 0.09); cy = lerp(cy, ty, 0.09);
    flow = lerp(flow, flowTarget, 0.06);
    bloomBoost = lerp(bloomBoost, bloomTarget, 0.07);
    board.rotation.y = spin + scrollSpin + dragYaw + (dragging ? 0 : cx * 0.6);
    board.rotation.x = -0.5 + dragPitch + (dragging ? 0 : cy * 0.22);
    flowMat.uniforms.uSpeed.value = flow;
    if (bloom) bloom.strength = 0.35 + bloomBoost * 0.3;
    // exposure subtly lifts on interaction so the board "wakes up" without ever washing out
    renderer.toneMappingExposure = 0.62 + bloomBoost * 0.05;
    composer.render();
  }

  let raf = 0, running = false, active = false, last = 0, disposed = false;
  function tick(now) {
    if (!running || disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!reduced && !dragging) spin += dt * 0.05 * (1 + bloomBoost * 0.8);
    if (!dragging) { dragYaw += vel; vel *= 0.94; if (Math.abs(vel) < 0.0002) vel = 0; }
    flowMat.uniforms.uTime.value = now / 1000;
    // film grain is frozen (static pattern): animating it read as full-frame flicker
    frame();
    raf = requestAnimationFrame(tick);
  }
  function ensure() {
    if (reduced || running || disposed || !active) return;
    running = true; last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  // ---- context loss ----
  const onLost = e => { e.preventDefault(); running = false; if (raf) cancelAnimationFrame(raf); raf = 0; };
  const onRestored = () => {
    const old = envTex; envTex = pmrem.fromScene(new RoomEnvironment(), 0.02).texture; scene.environment = envTex; if (old) old.dispose();
    if (composer) { composer.renderTarget1?.dispose(); composer.renderTarget2?.dispose(); }
    gtao?.dispose?.(); bloom?.dispose?.(); grade?.dispose?.(); smaa?.dispose?.(); output?.dispose?.();
    composer = null; gtao = null; grade = null; smaa = null; output = null; size();
    if (reduced) frame(); else if (active) ensure();
  };
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  const ro = new ResizeObserver(() => { size(); if (reduced) frame(); });
  ro.observe(mount);
  size();

  if (!reduced) {
    mount.addEventListener('pointermove', onMove);
    mount.addEventListener('pointerleave', onLeave);
    mount.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  return {
    start() {
      active = true; size();
      if (reduced) { requestAnimationFrame(() => { flowMat.uniforms.uTime.value = 1.2; frame(); }); return; }
      ensure();
    },
    stop() {
      active = false;
      if (!running) return;
      running = false; if (raf) cancelAnimationFrame(raf); raf = 0;
    },
    dispose() {
      disposed = true; this.stop();
      ro.disconnect();
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      mount.removeEventListener('pointermove', onMove);
      mount.removeEventListener('pointerleave', onLeave);
      mount.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('scroll', onScroll);
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      hbm.dispose(); standoffs.dispose(); screws.dispose(); sockets.dispose();
      caps.dispose(); mos.dispose();
      disposables.forEach(d => d && d.dispose && d.dispose());
      if (composer) { composer.renderTarget1?.dispose(); composer.renderTarget2?.dispose(); }
      if (gtao) gtao.dispose?.();   // frees internal depth/normal GBuffer render targets + AO/PD/blend materials
      if (bloom) bloom.dispose?.();
      if (grade) grade.dispose?.();   // disposes the ShaderPass FullScreenQuad material
      if (smaa) smaa.dispose?.();     // frees SMAA's internal edge/weight textures + render target
      if (output) output.dispose?.(); // disposes OutputPass's FullScreenQuad material
      if (envTex) envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
