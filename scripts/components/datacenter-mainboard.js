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

// Data-center GPU mainboard / baseboard: the large dark multilayer PCB that carries
// several heatsinked accelerator module sites in a grid, multi-phase VRM power-delivery
// banks (DrMOS rows + chokes + bulk caps), large power connectors, a board edge
// connector and board-to-board connectors, and a fine network of copper traces with a
// subtle traveling-light "electricity" pulse flowing along them. Original representation
// of the generic data-center GPU baseboard hardware class: no logos, wordmarks, model
// numbers, or proprietary trade dress; any silk/etch is generic and invented.
// Cursor orbits/tilts the board and quickens the trace pulses; scroll rotates it on touch.
// Self-contained init(mount,ctx) -> {start,stop,dispose}; on-demand RAF,
// reduced-motion static frame, context-loss guard.

const OXIDE = '#d64545';
const lerp = (a, b, t) => a + (b - a) * t;

// Merged cinematic grade (one full-screen pass, linear space, BEFORE OutputPass so ACES
// stays the single tone-map/colorspace step, no double tone-mapping). Folds four product-shot
// effects into one pass to avoid per-pass render-target bandwidth:
//   - chromatic aberration: scales with radius^2 so the centre stays razor-sharp and only the
//     corners fringe, exactly how a real lens behaves (cheap glitch look avoided).
//   - subtle radial defocus: a faint screen-space blur that ramps in at the edges only, fakes a
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
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 8.4, 6.2);   // top-diagonal 3/4: high enough to read the wide board's grid, angled to catch the heatsinks
  camera.lookAt(0, -0.5, 0);          // aim at the board surface (board sits at y -0.55 + low component stack)

  const pmrem = new THREE.PMREMGenerator(renderer);
  // crisper IBL: low blur (0.02) keeps tight specular streaks on the brushed-metal heatsinks +
  // connector pins, which a dark scene leans on for shape; IBL is baked once, sharper costs nothing.
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
  scene.environment = envTex;

  // 3-point rig, single oxide-red rim is the only chromatic light. Tuned darker/cinematic:
  // a hotter, higher key for crisp metal speculars; a dimmer cool fill so shadow sides stay
  // moody rather than flat; the oxide rim grazes the back edge to detach the board from #0a0a0a.
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(6, 11, 6);
  const fill = new THREE.DirectionalLight(0x9fb6e0, 0.38); fill.position.set(-8, 3.5, 5);
  const rim = new THREE.DirectionalLight(0xd64545, 1.05); rim.position.set(-5, 5, -9);
  // faint top kicker (neutral) to put a thin gloss line along the heatsink fin crests
  const kick = new THREE.DirectionalLight(0xcfd6de, 0.26); kick.position.set(0, 12, -2);
  scene.add(key, fill, rim, kick, new THREE.AmbientLight(0x20242a, 0.22)); // lower ambient = deeper crevices

  const disposables = [];
  const track = o => { disposables.push(o); return o; };

  // ---- procedural PCB texture (dark multilayer solder mask + copper trace bundles + via field) ----
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
    // very dark solder mask (near-black green/teal) so the board reads as a deep multilayer PCB,
    // letting the copper traces + bright module heatsinks carry the contrast.
    const g = x.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#091210'); g.addColorStop(0.5, '#0b1714'); g.addColorStop(1, '#080f0d');
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    // faint horizontal/vertical routing channels (gives the board a manhattan-routed structure)
    x.lineCap = 'round';
    for (let i = 0; i < 220; i++) {
      const horiz = rng() < 0.5;
      x.strokeStyle = `rgba(${118 + rng() * 44 | 0},${78 + rng() * 34 | 0},38,${0.07 + rng() * 0.09})`;
      x.lineWidth = rng() < 0.22 ? 2.6 : 1.1;
      let px = rng() * size, py = rng() * size;
      x.beginPath(); x.moveTo(px, py);
      const segs = 2 + (rng() * 5 | 0);
      for (let s = 0; s < segs; s++) {
        // bias each segment to a single axis → orthogonal manhattan routing, occasional 45° jog
        if (rng() < 0.18) { px += (rng() - 0.5) * 90; py += (rng() - 0.5) * 90; }
        else if ((s % 2 === 0) === horiz) px += (rng() < 0.5 ? -1 : 1) * (50 + rng() * 230);
        else py += (rng() < 0.5 ? -1 : 1) * (50 + rng() * 230);
        x.lineTo(px, py);
      }
      x.stroke();
    }
    // dense via field + pads (annular copper ring with a dark drilled centre)
    for (let i = 0; i < 1100; i++) {
      const vx = rng() * size, vy = rng() * size, r = 0.9 + rng() * 2.0;
      x.fillStyle = 'rgba(150,110,55,0.26)'; x.beginPath(); x.arc(vx, vy, r, 0, 7); x.fill();
      x.fillStyle = 'rgba(5,9,7,0.9)'; x.beginPath(); x.arc(vx, vy, r * 0.45, 0, 7); x.fill();
    }
    // silkscreen refs: generic invented part designators only (NO branding/model numbers)
    x.fillStyle = 'rgba(186,196,192,0.46)'; x.font = '12px monospace';
    const refs = ['U7', 'L12', 'C84', 'Q3', 'R210', 'PH1', 'PH6', 'TP4', 'J9', 'VR2', 'FB3', 'D5'];
    for (let i = 0; i < 44; i++) x.fillText(refs[(rng() * refs.length) | 0], rng() * size, rng() * size);
    x.fillStyle = 'rgba(168,178,174,0.5)'; x.font = '11px monospace';
    x.fillText('REV C  LOT 7F-2241', size * 0.04, size * 0.975);
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

  // ---- materials (matte PBR: low envMapIntensity, anisotropy 0 → no glitter on the dark card) ----
  const brushTex = makeBrushTex();
  const pcbMat = new THREE.MeshPhysicalMaterial({
    map: makePCBTex(), color: 0x0e1c17, metalness: 0.32, roughness: 0.46,
    clearcoat: 0.42, clearcoatRoughness: 0.28, envMapIntensity: 0.8,
    sheen: 0.22, sheenRoughness: 0.62, sheenColor: new THREE.Color(0x132822), // soft solder-mask grazing glow
  });
  // accelerator-site heatsink: satin anodized aluminium, matte (roughnessMap micro-grain, no clearcoat)
  // so the grid of fins reads as machined metal, not chrome; low envMap kills sparkle on the dark stage.
  const heatsinkMat = new THREE.MeshPhysicalMaterial({
    color: 0x8a9097, metalness: 1.0, roughness: 0.56,
    roughnessMap: brushTex, anisotropy: 0, anisotropyRotation: 0,
    clearcoat: 0, clearcoatRoughness: 0.35, envMapIntensity: 0.42,
  });
  // module baseplate / IHS lid under the sink: warmer nickel-plated copper, satin brushed
  const lidMat = new THREE.MeshPhysicalMaterial({
    color: 0xada89f, metalness: 1.0, roughness: 0.48,
    roughnessMap: brushTex, normalMap: brushTex, normalScale: new THREE.Vector2(0.09, 0.09),
    anisotropy: 0, clearcoat: 0, envMapIntensity: 0.44,
  });
  const screwMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.55, anisotropy: 0, envMapIntensity: 0.5 }); // turned-metal standoff/screw
  const sockMat = new THREE.MeshPhysicalMaterial({ color: 0x2a2d31, metalness: 1.0, roughness: 0.5, envMapIntensity: 0.6 });            // recessed hex socket
  const backMat = new THREE.MeshPhysicalMaterial({ color: 0x1d2024, metalness: 1.0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, envMapIntensity: 0.85 }); // anodized backplate
  // --- power-delivery materials ---
  const mosMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, metalness: 0.32, roughness: 0.46, envMapIntensity: 0.6 });           // dark DrMOS power stage (molded epoxy)
  const chokeMat = new THREE.MeshPhysicalMaterial({ color: 0x232629, metalness: 0.45, roughness: 0.66, envMapIntensity: 0.4 });         // ferrite VRM choke (matte dark grey)
  const capBodyMat = new THREE.MeshPhysicalMaterial({ color: 0x16181b, metalness: 0.3, roughness: 0.5, envMapIntensity: 0.55 });        // bulk cap sleeve (dark)
  const capTopMat = new THREE.MeshPhysicalMaterial({ color: 0x8f949b, metalness: 1.0, roughness: 0.5, anisotropy: 0, envMapIntensity: 0.45 }); // cap aluminium top w/ vent cross
  // --- connector materials ---
  const plasticMat = new THREE.MeshPhysicalMaterial({ color: 0x0c0d10, metalness: 0.0, roughness: 0.52, clearcoat: 0.15, clearcoatRoughness: 0.5, envMapIntensity: 0.5 }); // black connector shroud
  const pinMat = new THREE.MeshPhysicalMaterial({ color: 0xb9bcc1, metalness: 1.0, roughness: 0.42, anisotropy: 0, envMapIntensity: 0.5 }); // tin/nickel connector pins
  // sparing gold: edge-connector contact fingers + a few decoupling accents (used very sparingly)
  const goldAccent = new THREE.MeshPhysicalMaterial({ color: 0xc89a52, metalness: 1.0, roughness: 0.5, anisotropy: 0, envMapIntensity: 0.45 });
  // tiny status LED (the one non-trace oxide accent): emissive, blooms faintly
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x2a0c0c, emissive: new THREE.Color(OXIDE), emissiveIntensity: 2.2, roughness: 0.4, metalness: 0 });
  [pcbMat, heatsinkMat, lidMat, screwMat, sockMat, backMat,
   mosMat, chokeMat, capBodyMat, capTopMat, plasticMat, pinMat, goldAccent, ledMat].forEach(track);

  // ---- mainboard / baseboard assembly (wide rectangular multilayer PCB) ----
  const board = new THREE.Group();
  const W = 8.2, D = 5.4, pcbH = 0.20;    // wide rectangular baseboard footprint
  const m4 = new THREE.Matrix4();

  // dark multilayer PCB baseboard (the carrier the accelerators bolt to)
  const pcb = new THREE.Mesh(track(new RoundedBoxGeometry(W, pcbH, D, 3, 0.08)), pcbMat);
  pcb.position.y = pcbH / 2;
  board.add(pcb);

  // ---- accelerator module sites: a 3x2 grid of heatsinked module blocks bolted to the board.
  // Each site = organic-laminate substrate + nickel/copper IHS lid + finned heatsink + 4 corner
  // screws. Built as InstancedMeshes (one instance per site) so the repeated hardware is one draw
  // call per layer. Grid spans the left ~2/3 of the board; the right strip carries power/connectors.
  const COLS = 3, ROWS = 2;
  const siteW = 1.78, siteD = 1.78;       // module footprint
  const gridX0 = -W / 2 + 1.35;           // left edge of the grid
  const gridZ0 = -D / 2 + 1.35;           // near edge of the grid
  const colPitch = 2.0, rowPitch = 2.35;
  const sites = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    sites.push([gridX0 + c * colPitch, gridZ0 + r * rowPitch]);
  }
  const subY = pcbH + 0.04;

  // module substrate (dark green-black organic laminate carrier under each accelerator)
  const subGeo = track(new RoundedBoxGeometry(siteW, 0.09, siteD, 2, 0.03));
  const subInst = new THREE.InstancedMesh(subGeo, pcbMat, sites.length);
  sites.forEach((p, i) => { m4.makeTranslation(p[0], subY, p[1]); subInst.setMatrixAt(i, m4); });
  subInst.instanceMatrix.needsUpdate = true;
  board.add(subInst);

  // IHS lid (nickel-plated copper heat-spreader) seated on the substrate
  const lidGeo = track(new RoundedBoxGeometry(siteW * 0.74, 0.12, siteD * 0.74, 2, 0.035));
  const lidY = subY + 0.10;
  const lidInst = new THREE.InstancedMesh(lidGeo, lidMat, sites.length);
  sites.forEach((p, i) => { m4.makeTranslation(p[0], lidY, p[1]); lidInst.setMatrixAt(i, m4); });
  lidInst.instanceMatrix.needsUpdate = true;
  board.add(lidInst);

  // finned heatsink on top of the lid: a solid base slab (one InstancedMesh across sites) plus a
  // separate InstancedMesh of thin fin slabs (FINS_PER per site) riding on the base. Two draw calls
  // total for every heatsink on the board; the grid of finned sinks is the hero read of the mainboard.
  const sinkBaseGeo = track(new RoundedBoxGeometry(siteW * 0.78, 0.10, siteD * 0.78, 2, 0.03));
  const sinkY = lidY + 0.10;
  const sinkInst = new THREE.InstancedMesh(sinkBaseGeo, heatsinkMat, sites.length);
  sites.forEach((p, i) => { m4.makeTranslation(p[0], sinkY, p[1]); sinkInst.setMatrixAt(i, m4); });
  sinkInst.instanceMatrix.needsUpdate = true;
  board.add(sinkInst);

  // heatsink fins: one InstancedMesh of thin fin slabs across ALL sites (FINS_PER * sites total).
  const FINS_PER = 9, finGap = (siteD * 0.74) / FINS_PER;
  const finGeo = track(new THREE.BoxGeometry(siteW * 0.72, 0.26, finGap * 0.42));
  const fins = new THREE.InstancedMesh(finGeo, heatsinkMat, FINS_PER * sites.length);
  const finY = sinkY + 0.05 + 0.13;
  let fi = 0;
  sites.forEach(p => {
    for (let f = 0; f < FINS_PER; f++) {
      const fz = p[1] - (siteD * 0.74) / 2 + finGap * (f + 0.5);
      m4.makeTranslation(p[0], finY, fz);
      fins.setMatrixAt(fi++, m4);
    }
  });
  fins.instanceMatrix.needsUpdate = true;
  board.add(fins);

  // four corner mounting screws per site (one InstancedMesh, 4 * sites), with sunk hex sockets.
  const screwGeo = track(new THREE.CylinderGeometry(0.075, 0.075, 0.07, 14));
  const sockGeo = track(new THREE.CylinderGeometry(0.04, 0.04, 0.045, 6));
  const so = siteW / 2 - 0.12;
  const screwOffsets = [[-so, -so], [so, -so], [-so, so], [so, so]];
  const screws = new THREE.InstancedMesh(screwGeo, screwMat, screwOffsets.length * sites.length);
  const sockets = new THREE.InstancedMesh(sockGeo, sockMat, screwOffsets.length * sites.length);
  let si = 0;
  sites.forEach(p => {
    screwOffsets.forEach(o => {
      m4.makeTranslation(p[0] + o[0], subY + 0.07, p[1] + o[1]); screws.setMatrixAt(si, m4);
      m4.makeTranslation(p[0] + o[0], subY + 0.10, p[1] + o[1]); sockets.setMatrixAt(si, m4);
      si++;
    });
  });
  screws.instanceMatrix.needsUpdate = true; sockets.instanceMatrix.needsUpdate = true;
  board.add(screws, sockets);

  // ---- anodized backplate: closes the underside (visible once orbited 360) ----
  const backplate = new THREE.Mesh(track(new RoundedBoxGeometry(W * 0.99, 0.06, D * 0.99, 2, 0.05)), backMat);
  backplate.position.y = -0.04;
  board.add(backplate);

  // ---- power-delivery banks: VRM phase rows (DrMOS power stages + ferrite chokes) running
  // along the right strip of the board, feeding the module grid. DrMOS + chokes are paired per
  // phase; each is its own InstancedMesh so the whole bank is two draw calls.
  const pdX = W / 2 - 1.5;                 // centre of the right power strip
  const PHASES = 7, phasePitch = (D - 1.4) / PHASES;
  const phaseZ0 = -D / 2 + 0.9;
  const mosGeo = track(new THREE.BoxGeometry(0.30, 0.07, 0.26));
  const mos = new THREE.InstancedMesh(mosGeo, mosMat, PHASES * 2);
  const chokeGeo = track(new THREE.BoxGeometry(0.34, 0.24, 0.34));   // squat ferrite block choke
  const chokes = new THREE.InstancedMesh(chokeGeo, chokeMat, PHASES * 2);
  let pmi = 0, pci = 0;
  for (let row = 0; row < 2; row++) {
    const rx = pdX + (row - 0.5) * 0.95;
    for (let ph = 0; ph < PHASES; ph++) {
      const z = phaseZ0 + ph * phasePitch;
      m4.makeTranslation(rx - 0.32, pcbH + 0.035, z); mos.setMatrixAt(pmi++, m4);
      m4.makeTranslation(rx + 0.16, pcbH + 0.12, z); chokes.setMatrixAt(pci++, m4);
    }
  }
  mos.instanceMatrix.needsUpdate = true; chokes.instanceMatrix.needsUpdate = true;
  board.add(mos, chokes);

  // bulk filter capacitors: a short row of can caps near the power strip (body + vented metal top).
  const capN = 6;
  const capBodyGeo = track(new THREE.CylinderGeometry(0.16, 0.16, 0.34, 20));
  const capTopGeo = track(new THREE.CylinderGeometry(0.155, 0.155, 0.03, 20));
  const capBodies = new THREE.InstancedMesh(capBodyGeo, capBodyMat, capN);
  const capTops = new THREE.InstancedMesh(capTopGeo, capTopMat, capN);
  for (let i = 0; i < capN; i++) {
    const cz = -D / 2 + 1.1 + i * ((D - 2.2) / (capN - 1));
    m4.makeTranslation(W / 2 - 0.55, pcbH + 0.17, cz); capBodies.setMatrixAt(i, m4);
    m4.makeTranslation(W / 2 - 0.55, pcbH + 0.345, cz); capTops.setMatrixAt(i, m4);
  }
  capBodies.instanceMatrix.needsUpdate = true; capTops.instanceMatrix.needsUpdate = true;
  board.add(capBodies, capTops);

  // ---- large power connectors: two black multi-pin power blocks along the front edge that feed
  // the VRM banks (shroud + recessed gold/tin pin field). Shroud is a single mesh each; pins are
  // one shared InstancedMesh across both connectors.
  const pwrShroudGeo = track(new RoundedBoxGeometry(1.1, 0.34, 0.5, 2, 0.04));
  const pwrPos = [[pdX - 0.2, D / 2 - 0.45], [pdX - 1.7, D / 2 - 0.45]];
  pwrPos.forEach(p => {
    const sh = new THREE.Mesh(pwrShroudGeo, plasticMat);
    sh.position.set(p[0], pcbH + 0.17, p[1]);
    board.add(sh);
  });
  const pwrPinGeo = track(new THREE.BoxGeometry(0.05, 0.18, 0.05));
  const PWR_COLS = 6, PWR_ROWS = 2;
  const pwrPins = new THREE.InstancedMesh(pwrPinGeo, goldAccent, PWR_COLS * PWR_ROWS * pwrPos.length);
  let ppi = 0;
  pwrPos.forEach(p => {
    for (let r = 0; r < PWR_ROWS; r++) for (let c = 0; c < PWR_COLS; c++) {
      m4.makeTranslation(p[0] - 0.45 + c * 0.16, pcbH + 0.30, p[1] - 0.12 + r * 0.24);
      pwrPins.setMatrixAt(ppi++, m4);
    }
  });
  pwrPins.instanceMatrix.needsUpdate = true;
  board.add(pwrPins);

  // ---- large board edge connector: gold contact fingers along the back edge (the baseboard's
  // host interface). A thin plastic key block + an InstancedMesh of gold fingers.
  const edgeKey = new THREE.Mesh(track(new RoundedBoxGeometry(W * 0.6, 0.12, 0.34, 2, 0.03)), plasticMat);
  edgeKey.position.set(0, pcbH + 0.05, -D / 2 + 0.22);
  board.add(edgeKey);
  const fingerGeo = track(new THREE.BoxGeometry(0.07, 0.04, 0.30));
  const FINGERS = 30;
  const fingers = new THREE.InstancedMesh(fingerGeo, goldAccent, FINGERS);
  const fSpan = W * 0.56, fx0 = -fSpan / 2;
  for (let i = 0; i < FINGERS; i++) {
    m4.makeTranslation(fx0 + i * (fSpan / (FINGERS - 1)), pcbH + 0.12, -D / 2 + 0.22);
    fingers.setMatrixAt(i, m4);
  }
  fingers.instanceMatrix.needsUpdate = true;
  board.add(fingers);

  // ---- board-to-board connectors: two low mezzanine headers between module rows (black shroud +
  // tin pin field) for stacking daughter cards. Shrouds are meshes; pins are one InstancedMesh.
  const mezzGeo = track(new RoundedBoxGeometry(1.5, 0.16, 0.26, 2, 0.03));
  const mezzPos = [[gridX0 + colPitch * 0.5, gridZ0 + rowPitch * 0.5], [gridX0 + colPitch * 1.5, gridZ0 + rowPitch * 0.5]];
  mezzPos.forEach(p => {
    const mz = new THREE.Mesh(mezzGeo, plasticMat);
    mz.position.set(p[0], pcbH + 0.08, p[1]);
    board.add(mz);
  });
  const mezzPinGeo = track(new THREE.BoxGeometry(0.03, 0.10, 0.03));
  const MEZZ_N = 24;
  const mezzPins = new THREE.InstancedMesh(mezzPinGeo, pinMat, MEZZ_N * mezzPos.length);
  let mpi = 0;
  mezzPos.forEach(p => {
    for (let i = 0; i < MEZZ_N; i++) {
      m4.makeTranslation(p[0] - 0.65 + (i % 12) * 0.118, pcbH + 0.17, p[1] - 0.05 + (i < 12 ? 0 : 0.1));
      mezzPins.setMatrixAt(mpi++, m4);
    }
  });
  mezzPins.instanceMatrix.needsUpdate = true;
  board.add(mezzPins);

  // ---- tiny oxide-red status LED near a corner (the only non-trace oxide accent) ----
  const led = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.04, 0.05)), ledMat);
  led.position.set(-W / 2 + 0.45, pcbH + 0.025, -D / 2 + 0.7);
  board.add(led);

  // ---- copper trace electricity: a fine network of raised trace runs across the board with a
  // SUBTLE traveling-light pulse flowing along each path. Reuses the coolant flow-shader TECHNIQUE
  // (fract UV-scroll pulse, additive, bloom does the glow) on thin TubeGeometry along CatmullRom
  // paths just above the solder mask. Several short routes are merged-by-instance: each route is its
  // own tube mesh sharing ONE shader material, so all pulses animate from a single uTime/uSpeed.
  // Cool electric tone on the dark board; faint: it is an accent flowing through the traces, not glow.
  const traceY = pcbH + 0.012;             // hair above the mask so the pulse reads as on-board
  const traceMat = track(new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uSpeed: { value: 0.18 },        // slow base glide, current eases along, never races
      uColor: { value: new THREE.Color(0x59c6ff) },        // cool electric blue: reads on dark, LED keeps the oxide accent
      uHot: { value: new THREE.Color(0xddf1ff) },          // hotter leading-edge spark
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform float uTime; uniform float uSpeed; uniform vec3 uColor; uniform vec3 uHot; varying vec2 vUv;',
      'void main(){',
      '  float n = 2.0;',                                   // SPARSE: 2 pulses per route, occasional not streaming
      '  float f = fract(vUv.x * n - uTime * uSpeed);',
      '  float head = smoothstep(0.0, 0.05, f);',           // sharp leading edge
      '  float tail = 1.0 - smoothstep(0.05, 0.55, f);',    // long fade tail → a comet of current, not a band
      '  float pulse = head * tail;',
      '  float facing = 0.6 + 0.4 * abs(cos(vUv.y * 6.2831));', // brightest on the top-facing sliver, underside stays dark
      '  float a = 0.05 + pulse * 0.85;',                   // faint resting copper sheen + a thin traveling head
      '  vec3 col = mix(uColor, uHot, head * (1.0 - tail) * 0.55);', // spark hot at the front, oxide-cool in the tail
      '  gl_FragColor = vec4(col * a * facing, a * facing);',
      '}',
    ].join('\n'),
  }));
  // route generator: short manhattan-ish runs linking connectors → power → module sites.
  const traceRng = mulberry32(53);
  const traceRoutes = [];
  // a) connector edge → each module site (signal fan-out)
  sites.forEach((s, idx) => {
    const startX = fx0 + (idx + 1) * (fSpan / (sites.length + 1));
    traceRoutes.push([
      new THREE.Vector3(startX, traceY, -D / 2 + 0.35),
      new THREE.Vector3(startX, traceY, s[1] - 0.9),
      new THREE.Vector3(s[0] - 0.5, traceY, s[1] - 0.9),
      new THREE.Vector3(s[0] - 0.5, traceY, s[1]),
    ]);
  });
  // b) power strip → nearest module sites (power fan-in)
  for (let r = 0; r < ROWS; r++) {
    const s = sites[r * COLS + (COLS - 1)];
    traceRoutes.push([
      new THREE.Vector3(pdX - 0.6, traceY, s[1]),
      new THREE.Vector3(s[0] + 0.6, traceY, s[1]),
      new THREE.Vector3(s[0] + 0.45, traceY, s[1]),
    ]);
  }
  // c) a few free wandering bus runs for density
  for (let i = 0; i < 5; i++) {
    const z = -D / 2 + 0.8 + traceRng() * (D - 1.6);
    traceRoutes.push([
      new THREE.Vector3(-W / 2 + 0.5, traceY, z),
      new THREE.Vector3(-W / 2 + 1.5 + traceRng() * 2, traceY, z + (traceRng() - 0.5) * 0.6),
      new THREE.Vector3(0.5 + traceRng() * 2, traceY, z + (traceRng() - 0.5) * 0.8),
    ]);
  }
  const traceMeshes = [];
  traceRoutes.forEach(pts => {
    const crv = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
    const tg = track(new THREE.TubeGeometry(crv, Math.max(12, pts.length * 8), 0.012, 6, false));
    const tm = new THREE.Mesh(tg, traceMat);
    tm.renderOrder = 2;     // draw over the board so additive pulse reads cleanly
    board.add(tm);
    traceMeshes.push(tm);
  });

  // rest pose + recentre: well-framed top-diagonal 3/4 view of the wide board (fills the view)
  board.rotation.x = -0.62;
  board.rotation.y = -0.42;
  board.position.y = -0.55;
  scene.add(board);

  // grounded contact shadow under the board (wide rectangular footprint → wide blob)
  const shadowMat = track(new THREE.MeshBasicMaterial({
    map: makeShadowTex(), transparent: true, depthWrite: false, opacity: 0.9, color: 0x000000,
  }));
  const shadowPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(W * 1.7, D * 1.9)), shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = -1.5;    // below the board's lowest swept point so it reads as cast, not stuck
  shadowPlane.renderOrder = -1;     // draw before the board
  scene.add(shadowPlane);           // child of scene, not board → stays grounded as the board orbits

  // ---- postprocessing (GTAO occlusion → bloom → cinematic grade → SMAA → ACES output) ----
  let composer, bloom, gtao, grade, smaa, output;
  function buildComposer(w, h) {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { samples: 4 }));
    composer.addPass(new RenderPass(scene, camera));
    // GTAO darkens the heatsink fin gaps, the seams where the module sites/connectors/chokes meet
    // the board, and under the component overhangs: the #1 cue that sells a machined assembly
    // (PBR metal looks plasticky with no occlusion in the gaps the env map floods). Skip on
    // touch/low-power (noHover) to protect that budget. Goes BEFORE bloom so occluded areas don't bloom.
    if (!noHover) {
      gtao = new GTAOPass(scene, camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;   // beauty * denoised AO (ship this; .AO/.Denoise are debug views)
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({
        radius: 0.35,           // world units, tuned for the fin pitch + component-to-board seams on the wide board
        distanceExponent: 1.0,
        thickness: 0.4,         // thin fins + low components: smaller thickness keeps the AO from over-darkening
        distanceFallOff: 0.6,
        scale: 1.1,
        samples: 16,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 2, rings: 2, samples: 8 });
      composer.addPass(gtao);
    }
    // With GTAO darkening crevices, keep bloom tight (high threshold) so only the trace-electricity
    // pulses + the tiny status LED bloom, not the matte metal speculars; the board itself stays dark.
    bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.3, 0.45, 0.95);
    composer.addPass(bloom);
    // cinematic grade (vignette + chromatic aberration + edge-defocus + grain), linear space,
    // after bloom so the glow is part of what gets graded, before SMAA + OutputPass.
    grade = new ShaderPass(GradeShader);
    grade.uniforms.uTexel.value.set(1 / w, 1 / h);
    if (reduced) grade.uniforms.uGrain.value = 0;   // no animated grain on the reduced-motion static frame
    composer.addPass(grade);
    // SMAA: the composer bypasses the renderer's MSAA, so fin/pin/finger/trace edges alias on the
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
  let spin = -0.42, scrollSpin = 0;      // start at the rest diagonal yaw; idle drift from there
  let flow = 0.18, flowTarget = 0.18;    // trace-electricity pulse speed (slow rest; quickens gently on interaction)
  let bloomBoost = 0, bloomTarget = 0;
  let dragging = false, dragYaw = 0, dragPitch = 0, vel = 0, lastX = 0, lastY = 0;  // click-drag 360 orbit

  function onMove(e) {
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      dragYaw += dx * 0.01;
      dragPitch = Math.max(-0.5, Math.min(0.5, dragPitch + dy * 0.006));
      vel = dx * 0.01;
      flowTarget = 0.5; bloomTarget = 1;
      ensure();
      return;
    }
    const r = mount.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    flowTarget = 0.5; bloomTarget = 1;
    ensure();
  }
  function onLeave() { if (!dragging) { tx = 0; ty = 0; flowTarget = 0.18; bloomTarget = 0; ensure(); } }
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
      if (noHover) { flowTarget = 0.42; bloomTarget = 0.7; }
      ensure();
    });
  }

  // ---- render + loop ----
  function frame() {
    cx = lerp(cx, tx, 0.09); cy = lerp(cy, ty, 0.09);
    flow = lerp(flow, flowTarget, 0.06);
    bloomBoost = lerp(bloomBoost, bloomTarget, 0.07);
    board.rotation.y = spin + scrollSpin + dragYaw + (dragging ? 0 : cx * 0.6);
    board.rotation.x = -0.62 + dragPitch + (dragging ? 0 : cy * 0.22);
    traceMat.uniforms.uSpeed.value = flow;
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
    traceMat.uniforms.uTime.value = now / 1000;
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
    composer = null; gtao = null; bloom = null; grade = null; smaa = null; output = null; size();
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
      // reduced-motion: freeze the trace pulses mid-run (current "caught" in the copper), no implicit motion
      if (reduced) { requestAnimationFrame(() => { traceMat.uniforms.uTime.value = 0.65; traceMat.uniforms.uSpeed.value = 0; frame(); }); return; }
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
      subInst.dispose(); lidInst.dispose(); sinkInst.dispose(); fins.dispose();
      screws.dispose(); sockets.dispose();
      mos.dispose(); chokes.dispose(); capBodies.dispose(); capTops.dispose();
      pwrPins.dispose(); fingers.dispose(); mezzPins.dispose();
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
