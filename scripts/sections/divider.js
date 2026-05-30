import * as THREE from 'three';

// DIVIDER: PCIe Gen5 x16 lane particle field, framed for a wide short band.
// Ported from demos/final/t09-a.html. Ambient, additive, white -> oxide gradient.

const LANES      = 16;
const ROWS       = 2;
const PER_ROW    = 8;
const PARTICLES  = 3000;
const FLOW_SPEED = 0.075;
const LANE_LEN   = 14.0;
const LANE_W     = 0.40;
const LANE_H     = 0.15;
const LANE_GAP_X = 0.56;
const LANE_GAP_Y = 1.05;

const COL_WHITE  = 0xeaeaea;
const COL_ACCENT = 0xd64545;
const BG         = 0x0a0a0a;

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(BG, 1);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 13, 30);

  // wide-band framing: pull the camera lower and longer so the lanes read as
  // a flat horizontal stream across a short band rather than a tall package.
  // near-head-on tilt so the lanes converge toward a vanishing point and the
  // moving charge, not the chassis, carries the frame.
  const frustum = 3.4;
  const camera = new THREE.OrthographicCamera(-1, 1, frustum, -frustum, 0.1, 100);
  camera.position.set(9, 2.2, 9);
  camera.lookAt(0, -0.1, 0);

  // lanes
  const lanes = [];
  const rowSpan = PER_ROW * LANE_W + (PER_ROW - 1) * LANE_GAP_X;
  const startZ = -rowSpan / 2 + LANE_W / 2;

  // lane chassis recedes to a faint hint; the charge carries the visual.
  const laneFloorMat = new THREE.MeshBasicMaterial({ color: 0x131313, transparent: true, opacity: 0.06 });
  const disposables = [laneFloorMat];

  const laneGroup = new THREE.Group();

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < PER_ROW; c++) {
      const idx = r * PER_ROW + c;
      const y = (r === 0 ? 1 : -1) * LANE_GAP_Y / 2;
      const z = startZ + c * (LANE_W + LANE_GAP_X);

      const boxGeo = new THREE.BoxGeometry(LANE_LEN, LANE_H, LANE_W);
      const floor = new THREE.Mesh(boxGeo, laneFloorMat);
      floor.position.set(0, y, z);
      laneGroup.add(floor);

      const t = idx / (LANES - 1);
      const sheenCol = new THREE.Color(COL_WHITE).lerp(new THREE.Color(COL_ACCENT), Math.pow(t, 0.85));
      const sheenGeo = new THREE.PlaneGeometry(LANE_LEN, LANE_W * 0.6);
      const sheenMat = new THREE.MeshBasicMaterial({
        color: sheenCol,
        transparent: true,
        opacity: 0.04 + 0.05 * t,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sheen = new THREE.Mesh(sheenGeo, sheenMat);
      sheen.rotation.x = -Math.PI / 2;
      sheen.position.set(0, y + LANE_H / 2 + 0.002, z);
      laneGroup.add(sheen);

      disposables.push(boxGeo, sheenGeo, sheenMat);
      lanes.push({ y, z, idx });
    }
  }
  scene.add(laneGroup);

  // connector pads at both lane mouths
  const padMat = new THREE.MeshBasicMaterial({ color: 0xd64545, transparent: true, opacity: 0.28 });
  const padGeo = new THREE.BoxGeometry(0.16, LANE_H * 1.5, LANE_W * 1.15);
  disposables.push(padMat, padGeo);
  for (let side = -1; side <= 1; side += 2) {
    for (const lp of lanes) {
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(side * (LANE_LEN / 2 + 0.14), lp.y, lp.z);
      scene.add(pad);
    }
  }

  // particles
  const positions = new Float32Array(PARTICLES * 3);
  const aLane = new Float32Array(PARTICLES);
  const aSpeed = new Float32Array(PARTICLES);
  const aSeed = new Float32Array(PARTICLES);
  const aOffset = new Float32Array(PARTICLES);

  for (let i = 0; i < PARTICLES; i++) {
    const l = i % LANES;
    const lp = lanes[l];
    aLane[i] = l;
    aSpeed[i] = 0.6 + Math.random() * 1.5;
    aSeed[i] = Math.random();
    aOffset[i] = Math.random();

    positions[i * 3 + 0] = -LANE_LEN / 2 + aOffset[i] * LANE_LEN;
    positions[i * 3 + 1] = lp.y + (Math.random() - 0.5) * (LANE_H * 0.5);
    positions[i * 3 + 2] = lp.z + (Math.random() - 0.5) * (LANE_W * 0.5);
  }

  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  pGeo.setAttribute('aLane', new THREE.BufferAttribute(aLane, 1));
  pGeo.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
  pGeo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  pGeo.setAttribute('aOffset', new THREE.BufferAttribute(aOffset, 1));

  const pMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLen: { value: LANE_LEN },
      uLanes: { value: LANES },
      uSpeed: { value: FLOW_SPEED },
      uPixel: { value: renderer.getPixelRatio() },
      uStatic: { value: reduced ? 1.0 : 0.0 },
      uWhite: { value: new THREE.Color(COL_WHITE) },
      uAccent: { value: new THREE.Color(COL_ACCENT) },
    },
    vertexShader: `
      attribute float aLane;
      attribute float aSpeed;
      attribute float aSeed;
      attribute float aOffset;
      uniform float uTime;
      uniform float uLen;
      uniform float uSpeed;
      uniform float uPixel;
      uniform float uStatic;
      varying float vLane;
      varying float vAlpha;

      void main() {
        vLane = aLane;
        vec3 pos = position;

        float travel = mod(aOffset + uTime * aSpeed * uSpeed * (1.0 - uStatic), 1.0);
        pos.x = -uLen * 0.5 + travel * uLen;

        float wob = (1.0 - uStatic);
        pos.y += sin(uTime * 1.6 + aSeed * 6.2831) * 0.010 * wob;
        pos.z += cos(uTime * 1.2 + aSeed * 6.2831) * 0.010 * wob;

        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;

        float size = mix(3.0, 6.0, aSeed) * uPixel;
        gl_PointSize = size * (8.0 / -mv.z);

        // short leading-edge band so packets streak into a trail before fading.
        float edge = smoothstep(0.0, 0.012, travel) * smoothstep(1.0, 0.86, travel);
        vAlpha = edge * (0.5 + 0.5 * aSeed);
      }
    `,
    fragmentShader: `
      uniform vec3 uWhite;
      uniform vec3 uAccent;
      uniform float uLanes;
      varying float vLane;
      varying float vAlpha;

      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.0, d);

        float t = vLane / max(uLanes - 1.0, 1.0);
        vec3 col = mix(uWhite, uAccent, pow(t, 0.85));

        gl_FragColor = vec4(col, a * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  disposables.push(pGeo, pMat);

  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);

  // sizing keyed to mount, not viewport
  function resize() {
    const w = Math.max(1, mount.clientWidth);
    const h = Math.max(1, mount.clientHeight);
    const a = w / h;
    camera.left = -frustum * a;
    camera.right = frustum * a;
    camera.top = frustum;
    camera.bottom = -frustum;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    pMat.uniforms.uPixel.value = renderer.getPixelRatio();
  }
  resize();

  const ro = new ResizeObserver(() => {
    resize();
    if (reduced || !raf) renderer.render(scene, camera);
  });
  ro.observe(mount);

  // context-loss guard: gate started so a stray start() race stays parked until restore
  function onLost(e) { e.preventDefault(); started = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function onRestored() { resize(); if (!reduced) start(); else renderer.render(scene, camera); }
  renderer.domElement.addEventListener('webglcontextlost', onLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onRestored, false);

  let raf = 0;
  let started = false;
  let last = 0;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    pMat.uniforms.uTime.value += dt;
    renderer.render(scene, camera);
  }

  function start() {
    started = true;
    if (reduced) { renderer.render(scene, camera); return; }
    if (raf) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    started = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function dispose() {
    stop();
    ro.disconnect();
    renderer.domElement.removeEventListener('webglcontextlost', onLost, false);
    renderer.domElement.removeEventListener('webglcontextrestored', onRestored, false);
    for (const d of disposables) { if (d && typeof d.dispose === 'function') d.dispose(); }
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  // Defer the first composed frame to a rAF so the ResizeObserver's first
  // callback can deliver a real width: rendering with a 0-width mount clamps the
  // ortho aspect to 1 and stretches the initial frame. Only render once sized.
  requestAnimationFrame(() => {
    if (mount.clientWidth > 0 && mount.clientHeight > 0) {
      resize();
      renderer.render(scene, camera);
    }
  });

  return { start, stop, dispose };
}
