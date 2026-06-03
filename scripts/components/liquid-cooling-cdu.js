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

// Liquid-cooled data-center GPU accelerator board: realistic PCB + VRM greebling
// + gold PCIe edge + finned cold plate, with a transparent coolant loop carrying
// a glowing oxide-red flow (TRON-like). Cursor orbits/tilts the board and speeds
// the coolant; scroll rotates it on touch. Self-contained init(mount,ctx) ->
// {start,stop,dispose}; on-demand RAF, reduced-motion static frame, context-loss
// guard. Same module contract as scripts/sections/proj-dcauto.js.

const OXIDE = '#d64545';
const lerp = (a, b, t) => a + (b - a) * t;

// Merged cinematic grade (one full-screen pass, linear space, BEFORE OutputPass so ACES
// stays the single tone-map/colorspace step — no double tone-mapping). Folds four product-shot
// effects into one pass to avoid per-pass render-target bandwidth:
//   - chromatic aberration: scales with radius^2 so the centre stays razor-sharp and only the
//     corners fringe, exactly how a real lens behaves (cheap glitch look avoided).
//   - subtle radial defocus: a faint screen-space blur that ramps in at the edges only — fakes a
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
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 5.8, 9.0);   // a touch higher for a top-leaning diagonal view
  camera.lookAt(0, 0.2, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  // crisper IBL: low blur (0.02) keeps tight specular streaks on the brushed metal + glass tube,
  // which a dark scene leans on for shape — IBL is baked once, so sharper costs nothing per frame.
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
  scene.environment = envTex;

  // 3-point rig, single oxide-red rim is the only chromatic light. Tuned darker/cinematic:
  // a hotter, higher key for crisp metal speculars; a dimmer cool fill so shadow sides stay
  // moody rather than flat; the oxide rim grazes the back edge to detach the board from #0a0a0a.
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 11, 6);
  const fill = new THREE.DirectionalLight(0x9fb6e0, 0.38); fill.position.set(-8, 3.5, 5);
  const rim = new THREE.DirectionalLight(0xd64545, 1.05); rim.position.set(-5, 5, -9);
  // faint top kicker (neutral) to put a thin gloss line along the fin crests
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
    // silkscreen refs
    x.fillStyle = 'rgba(190,200,196,0.5)'; x.font = '13px monospace';
    const refs = ['U1', 'L4', 'C12', 'Q3', 'R20', 'VRM', 'PHASE', 'TP1', 'J7'];
    for (let i = 0; i < 30; i++) x.fillText(refs[(rng() * refs.length) | 0], rng() * size, rng() * size);
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
    // leave colorSpace default (LinearSRGB) — this is a data map
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
  // machined brushed aluminium: anisotropic streak (grain follows UV → fin length) + faint anodized clearcoat
  const alu = new THREE.MeshPhysicalMaterial({
    color: 0xb9bcc0, metalness: 1.0, roughness: 0.52,
    roughnessMap: brushTex, normalMap: brushTex, normalScale: new THREE.Vector2(0.12, 0.12),
    anisotropy: 0, anisotropyRotation: Math.PI / 2,
    clearcoat: 0, clearcoatRoughness: 0.30, envMapIntensity: 0.4,
  });
  // cold-plate base: satin electroless-nickel read (matte, not chrome)
  const aluDark = new THREE.MeshPhysicalMaterial({
    color: 0x7a7f86, metalness: 1.0, roughness: 0.58,
    roughnessMap: brushTex, anisotropy: 0, anisotropyRotation: 0,
    clearcoat: 0, clearcoatRoughness: 0.35, envMapIntensity: 0.4,
  });
  // gold PCIe fingers: very smooth rolled edge with faint anisotropic sheen
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xe8b450, metalness: 1.0, roughness: 0.42, anisotropy: 0, envMapIntensity: 0.5 });
  const choke = new THREE.MeshPhysicalMaterial({ color: 0x3a3d42, metalness: 0.55, roughness: 0.62, envMapIntensity: 0.8 }); // matte molded ferrite
  const capMat = new THREE.MeshPhysicalMaterial({ color: 0x23262b, metalness: 0.8, roughness: 0.30, clearcoat: 0.4, clearcoatRoughness: 0.2, envMapIntensity: 0.9 }); // glossy electrolytic can sleeve
  const screwMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.55, anisotropy: 0, envMapIntensity: 0.5 }); // turned-metal look
  // --- greeble materials ---
  const pkgMat = new THREE.MeshPhysicalMaterial({ color: 0x14110e, metalness: 0.2, roughness: 0.55, envMapIntensity: 0.8 });           // BGA substrate laminate
  const lidMat = new THREE.MeshPhysicalMaterial({ color: 0x8c9096, metalness: 1.0, roughness: 0.5, clearcoat: 0, clearcoatRoughness: 0.2, anisotropy: 0, envMapIntensity: 0.5 }); // metal IHS lid
  const mosMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, metalness: 0.35, roughness: 0.45, envMapIntensity: 0.7 });           // DrMOS power stage
  const spCanMat = new THREE.MeshPhysicalMaterial({ color: 0xc4c8cc, metalness: 1.0, roughness: 0.5, envMapIntensity: 0.5 });          // silver SP-cap can
  const tantMat = new THREE.MeshPhysicalMaterial({ color: 0x161310, metalness: 0.15, roughness: 0.6, envMapIntensity: 0.6 });           // tantalum/POSCAP body
  const sockMat = new THREE.MeshPhysicalMaterial({ color: 0x2a2d31, metalness: 1.0, roughness: 0.5, envMapIntensity: 0.7 });            // recessed hex socket
  const headerMat = new THREE.MeshPhysicalMaterial({ color: 0x101113, metalness: 0.3, roughness: 0.55, envMapIntensity: 0.6 });         // black plastic connector shell
  const pinMat = new THREE.MeshPhysicalMaterial({ color: 0xb6bcc2, metalness: 1.0, roughness: 0.5, envMapIntensity: 0.5 });             // header contact pins
  const backMat = new THREE.MeshPhysicalMaterial({ color: 0x202327, metalness: 1.0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, envMapIntensity: 0.9 }); // anodized backplate
  const barbMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.5, anisotropy: 0, envMapIntensity: 0.5 }); // nickel barb fitting
  [pcbMat, alu, aluDark, gold, choke, capMat, screwMat,
   pkgMat, lidMat, mosMat, spCanMat, tantMat, sockMat, headerMat, pinMat, backMat, barbMat].forEach(track);

  // ---- board assembly ----
  const board = new THREE.Group();
  const W = 8.2, D = 3.6, pcbH = 0.18;

  const pcb = new THREE.Mesh(track(new RoundedBoxGeometry(W, pcbH, D, 3, 0.05)), pcbMat);
  pcb.position.y = pcbH / 2;
  board.add(pcb);

  // gold PCIe edge fingers along the front long edge
  const fingerGeo = track(new THREE.BoxGeometry(0.12, 0.05, 0.5));
  const fingerN = 30;
  const fingers = new THREE.InstancedMesh(fingerGeo, gold, fingerN);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < fingerN; i++) {
    m4.makeTranslation(-W / 2 + 0.6 + i * 0.2, 0.02, D / 2 - 0.28);
    fingers.setMatrixAt(i, m4);
  }
  fingers.instanceMatrix.needsUpdate = true;
  board.add(fingers);

  // VRM chokes (dark blocks) + caps (cylinders) near the left third
  const chokeGeo = track(new THREE.BoxGeometry(0.34, 0.26, 0.34));
  const chokeN = 8;
  const chokes = new THREE.InstancedMesh(chokeGeo, choke, chokeN);
  for (let i = 0; i < chokeN; i++) {
    m4.makeTranslation(-W / 2 + 0.7 + i * 0.42, pcbH + 0.13, -D / 2 + 0.5);
    chokes.setMatrixAt(i, m4);
  }
  chokes.instanceMatrix.needsUpdate = true;
  board.add(chokes);

  const capGeo = track(new THREE.CylinderGeometry(0.12, 0.12, 0.34, 16));
  const capN = 10;
  const caps = new THREE.InstancedMesh(capGeo, capMat, capN);
  // deterministic height jitter so the row reads as mixed capacitor values, not stamped clones
  const capRng = mulberry32(11);
  const _cp = new THREE.Vector3(), _cq = new THREE.Quaternion(), _cs = new THREE.Vector3();
  for (let i = 0; i < capN; i++) {
    const hs = 0.8 + capRng() * 0.6;   // 0.8..1.4 height multiplier
    _cp.set(-W / 2 + 0.7 + i * 0.34, pcbH + 0.17 * hs, -D / 2 + 0.95);
    _cs.set(1, hs, 1);
    m4.compose(_cp, _cq, _cs);
    caps.setMatrixAt(i, m4);
  }
  caps.instanceMatrix.needsUpdate = true;
  board.add(caps);

  // corner screws
  const screwGeo = track(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 12));
  const screwPos = [[-W / 2 + 0.3, D / 2 - 0.3], [W / 2 - 0.3, D / 2 - 0.3], [-W / 2 + 0.3, -D / 2 + 0.3], [W / 2 - 0.3, -D / 2 + 0.3]];
  const screws = new THREE.InstancedMesh(screwGeo, screwMat, screwPos.length);
  screwPos.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.02, p[1]); screws.setMatrixAt(i, m4); });
  screws.instanceMatrix.needsUpdate = true;
  board.add(screws);

  // recessed hex (Allen) socket sunk into each screw head — reads as a real mounting screw
  const sockGeo = track(new THREE.CylinderGeometry(0.052, 0.052, 0.05, 6));
  const sockets = new THREE.InstancedMesh(sockGeo, sockMat, screwPos.length);
  screwPos.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.05, p[1]); sockets.setMatrixAt(i, m4); });
  sockets.instanceMatrix.needsUpdate = true;
  board.add(sockets);

  // ---- BGA GPU package (the hero die: laminate substrate + metal IHS lid) ----
  // sits at the left edge of the cold plate so it peeks out from under the fins.
  const pkgX = -W / 2 + 2.4;
  const substrate = new THREE.Mesh(track(new RoundedBoxGeometry(1.5, 0.07, 1.5, 2, 0.02)), pkgMat);
  substrate.position.set(pkgX, pcbH + 0.035, 0.1);
  board.add(substrate);
  const lid = new THREE.Mesh(track(new RoundedBoxGeometry(1.15, 0.06, 1.15, 2, 0.02)), lidMat);
  lid.position.set(pkgX, pcbH + 0.085, 0.1);
  board.add(lid);

  // ---- DrMOS power stages: small black squares paired inboard of each choke ----
  const mosGeo = track(new THREE.BoxGeometry(0.26, 0.06, 0.26));
  const mos = new THREE.InstancedMesh(mosGeo, mosMat, chokeN);
  for (let i = 0; i < chokeN; i++) {
    m4.makeTranslation(-W / 2 + 0.7 + i * 0.42, pcbH + 0.03, -D / 2 + 0.92);
    mos.setMatrixAt(i, m4);
  }
  mos.instanceMatrix.needsUpdate = true;
  board.add(mos);

  // ---- silver SP-cap cans clustered in an L around the package ----
  const spGeo = track(new THREE.CylinderGeometry(0.1, 0.1, 0.18, 12));
  const spPos = [
    [pkgX - 0.95, -0.55], [pkgX - 0.95, -0.2], [pkgX - 0.95, 0.15], [pkgX - 0.95, 0.5],
    [pkgX - 0.55, 0.95], [pkgX - 0.2, 0.95], [pkgX + 0.15, 0.95], [pkgX + 0.5, 0.95],
  ];
  const spCans = new THREE.InstancedMesh(spGeo, spCanMat, spPos.length);
  spPos.forEach((p, i) => { m4.makeTranslation(p[0], pcbH + 0.09, p[1]); spCans.setMatrixAt(i, m4); });
  spCans.instanceMatrix.needsUpdate = true;
  board.add(spCans);

  // ---- tantalum/POSCAP blocks in a low row along the package bottom edge ----
  const tantGeo = track(new THREE.BoxGeometry(0.22, 0.05, 0.13));
  const tantN = 12;
  const tantalum = new THREE.InstancedMesh(tantGeo, tantMat, tantN);
  for (let i = 0; i < tantN; i++) {
    const row = i % 2, col = (i / 2) | 0;
    m4.makeTranslation(pkgX - 0.55 + col * 0.26, pcbH + 0.025, -0.85 - row * 0.18);
    tantalum.setMatrixAt(i, m4);
  }
  tantalum.instanceMatrix.needsUpdate = true;
  board.add(tantalum);

  // ---- power connector header at the far short edge (shell + instanced pins) ----
  const header = new THREE.Mesh(track(new THREE.BoxGeometry(1.5, 0.3, 0.42)), headerMat);
  const headerX = W / 2 - 1.0;
  header.position.set(headerX, pcbH + 0.15, -D / 2 + 0.32);
  board.add(header);
  const pinGeo = track(new THREE.BoxGeometry(0.05, 0.05, 0.3));
  const pinCols = 8;
  const pins = new THREE.InstancedMesh(pinGeo, pinMat, pinCols);
  for (let i = 0; i < pinCols; i++) {
    m4.makeTranslation(headerX - 0.6 + i * 0.17, pcbH + 0.2, -D / 2 + 0.32);
    pins.setMatrixAt(i, m4);
  }
  pins.instanceMatrix.needsUpdate = true;
  board.add(pins);

  // ---- anodized backplate: closes the underside (visible once orbited 360) ----
  const backplate = new THREE.Mesh(track(new RoundedBoxGeometry(W * 0.98, 0.06, D * 0.96, 2, 0.03)), backMat);
  backplate.position.y = -0.04;
  board.add(backplate);

  // ---- PCIe I/O bracket terminating the right short edge (vented) ----
  const bracket = new THREE.Mesh(track(new RoundedBoxGeometry(0.08, D * 0.9, 1.0, 2, 0.02)), alu);
  bracket.position.set(W / 2 + 0.02, pcbH + 0.3, 0);
  board.add(bracket);
  const slotGeo = track(new THREE.BoxGeometry(0.12, 0.5, 0.12));
  const slotN = 4;
  const slots = new THREE.InstancedMesh(slotGeo, mosMat, slotN); // dark vent slots
  for (let i = 0; i < slotN; i++) {
    m4.makeTranslation(W / 2 + 0.02, pcbH + 0.3, -0.36 + i * 0.24);
    slots.setMatrixAt(i, m4);
  }
  slots.instanceMatrix.needsUpdate = true;
  board.add(slots);

  // ---- finned cold plate (covers the right ~65% of the board) ----
  const plateW = W * 0.6, plateD = D * 0.86, plateBaseH = 0.18;
  const plateX = W * 0.12;
  const plateBaseY = pcbH + plateBaseH / 2 + 0.02;
  const coldBase = new THREE.Mesh(track(new RoundedBoxGeometry(plateW, plateBaseH, plateD, 2, 0.03)), aluDark);
  coldBase.position.set(plateX, plateBaseY, 0);
  board.add(coldBase);

  // instanced fins running along Z
  const finCount = 34, finH = 0.92, finT = 0.05, finGap = plateW / finCount;
  const finGeo = track(new THREE.BoxGeometry(finT, finH, plateD * 0.96));
  const fins = new THREE.InstancedMesh(finGeo, alu, finCount);
  const finY = plateBaseY + plateBaseH / 2 + finH / 2;
  for (let i = 0; i < finCount; i++) {
    m4.makeTranslation(plateX - plateW / 2 + finGap * (i + 0.5), finY, 0);
    fins.setMatrixAt(i, m4);
  }
  fins.instanceMatrix.needsUpdate = true;
  board.add(fins);
  const finTop = finY + finH / 2;

  // ---- coolant loop: glass tube + glowing inner flow core ----
  const lx0 = plateX - plateW / 2 + 0.3, lx1 = plateX + plateW / 2 - 0.3;
  const lz = plateD / 2 - 0.35, ly = finTop + 0.12;
  const pts = [
    new THREE.Vector3(lx0, ly, -lz),
    new THREE.Vector3(lx1, ly, -lz),
    new THREE.Vector3(lx1 + 0.5, ly - 0.2, 0),
    new THREE.Vector3(lx1, ly, lz),
    new THREE.Vector3(lx0, ly, lz),
    new THREE.Vector3(lx0 - 0.5, ly - 0.2, 0),
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

  // rest pose + recentre
  board.rotation.x = -0.64;
  board.rotation.y = -0.28;
  board.position.y = -0.4;
  scene.add(board);

  // grounded contact shadow under the board (slightly wider in X to match the 8.2x3.6 footprint)
  const shadowMat = track(new THREE.MeshBasicMaterial({
    map: makeShadowTex(), transparent: true, depthWrite: false, opacity: 0.9, color: 0x000000,
  }));
  const shadowPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(W * 1.5, D * 2.3)), shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = -1.55;   // below the board's lowest swept point so it reads as cast, not stuck
  shadowPlane.renderOrder = -1;     // draw before the board
  scene.add(shadowPlane);           // child of scene, not board → stays grounded as the board orbits

  // ---- postprocessing (GTAO occlusion → bloom → cinematic grade → SMAA → ACES output) ----
  let composer, bloom, gtao, grade, smaa, output;
  function buildComposer(w, h) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { samples: 4 }));
    composer.addPass(new RenderPass(scene, camera));
    // GTAO darkens the deep fin valleys and the crevices where chokes/caps/package meet the PCB —
    // the #1 cue that sells a machined assembly (PBR metal looks plasticky with no occlusion in the
    // gaps the env map floods). Skip on touch/low-power (noHover) to protect that budget.
    // Goes BEFORE bloom so occluded areas don't bloom back bright.
    if (!noHover) {
      gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;   // beauty * denoised AO (ship this; .AO/.Denoise are debug views)
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({
        radius: 0.5,            // world units — board is ~8 wide; reaches across the ~0.14 fin gaps + component bases
        distanceExponent: 1.0,
        thickness: 0.35,        // thin fins (finT 0.05): keep low so they don't over-occlude (default 1.0 is too much)
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
    // offscreen target once GTAO/bloom run — SMAA restores clean edges cheaply (one pass).
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
  let spin = -0.28, scrollSpin = 0;      // start at a gentle diagonal yaw; idle drift from there
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
      flowTarget = 1.9; bloomTarget = 1; lastInput = performance.now();
      ensure();
      return;
    }
    const r = mount.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    flowTarget = 1.9; bloomTarget = 1; lastInput = performance.now();
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
    lastInput = performance.now(); ensure();
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
      lastInput = performance.now();
      ensure();
    });
  }

  // ---- render + loop ----
  function frame() {
    cx = lerp(cx, tx, 0.09); cy = lerp(cy, ty, 0.09);
    flow = lerp(flow, flowTarget, 0.06);
    bloomBoost = lerp(bloomBoost, bloomTarget, 0.07);
    board.rotation.y = spin + scrollSpin + dragYaw + (dragging ? 0 : cx * 0.6);
    board.rotation.x = -0.64 + dragPitch + (dragging ? 0 : cy * 0.22);
    flowMat.uniforms.uSpeed.value = flow;
    if (bloom) bloom.strength = 0.35 + bloomBoost * 0.3;
    // exposure subtly lifts on interaction so the board "wakes up" without ever washing out
    renderer.toneMappingExposure = 0.62 + bloomBoost * 0.05;
    composer.render();
  }

  let raf = 0, running = false, active = false, last = 0, lastInput = 0, disposed = false;
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
      fingers.dispose(); chokes.dispose(); caps.dispose(); screws.dispose(); fins.dispose();
      sockets.dispose(); mos.dispose(); spCans.dispose(); tantalum.dispose(); pins.dispose(); slots.dispose();
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
