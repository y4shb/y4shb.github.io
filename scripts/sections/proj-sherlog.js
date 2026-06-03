// proj-sherlog - wireframe chip skeleton (oxide line-art anatomy) for the project card top.
// Ported from demos/final/t11-a.html. Dashed draw-in plays once, then a very slow orbit.
import * as THREE from 'three';

const ACCENT = 0xd64545;
const BG = 0x0a0a0a;
const TOTAL_DASH = 7;

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);

  let w = Math.max(1, mount.clientWidth);
  let h = Math.max(1, mount.clientHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 13, 34);

  const camera = new THREE.PerspectiveCamera(36, w / h, 0.1, 100);
  camera.position.set(7.2, 5.4, 9.2);
  camera.lookAt(0, -0.1, 0);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (e) {
    return { start() {}, stop() {}, dispose() {} }; // no WebGL -> inert handle
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  // Composite the faint log backdrop first, then the chip on top, in one clear.
  renderer.autoClear = false;
  renderer.setClearColor(BG, 1);
  scene.background = null; // clear() supplies the dark base so logs aren't overpainted
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  mount.appendChild(canvas);

  const root = new THREE.Group();
  root.rotation.x = 0.2;
  scene.add(root);

  const drawMats = [];
  const disposables = [];

  // ---- streaming-log backdrop (faint, BEHIND the chip) ----------------------
  // Offscreen canvas -> CanvasTexture -> fullscreen clip-space quad in its own
  // ortho scene rendered before the chip. Original, fabricated firmware-CI lines.
  const LOG_W = 256, LOG_H = 256;
  const LINE_H = 16;
  const MAX_LINES = Math.ceil(LOG_H / LINE_H) + 1;
  const logCanvas = document.createElement('canvas');
  logCanvas.width = LOG_W;
  logCanvas.height = LOG_H;
  const lctx = logCanvas.getContext('2d');

  const logTex = new THREE.CanvasTexture(logCanvas);
  logTex.minFilter = THREE.LinearFilter;
  logTex.magFilter = THREE.LinearFilter;
  logTex.generateMipmaps = false;
  logTex.colorSpace = THREE.SRGBColorSpace;

  const bgScene = new THREE.Scene();
  const bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bgGeo = new THREE.PlaneGeometry(2, 2);
  const logMat = new THREE.MeshBasicMaterial({
    map: logTex,
    transparent: true,
    opacity: 0.5,        // global knock-back; canvas alphas keep it faint already
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  bgScene.add(new THREE.Mesh(bgGeo, logMat));
  disposables.push(bgGeo, logMat, logTex);

  // -- original fabricated log content (MI450 / DCAuto firmware CI) --
  const NODES = ['mi450-n07', 'dcauto-fw03', 'regress-q2', 'flashbench-11', 'ci-runner-4', 'node-r12'];
  const ARTS = ['fw_dcauto_3.14.bin', 'mi450_uvm.pkg', 'boot_stage2.img', 'pll_trim.cfg', 'dca-b4821.pkg'];
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const rnd = (a, b) => a + ((Math.random() * (b - a + 1)) | 0);
  const hex = () => (Math.random() * 0xffff | 0).toString(16).padStart(4, '0');
  const OK = [
    () => `[PASS] regress/${pick(NODES)} sweep ok (${rnd(12, 98)} cases)`,
    () => `[INFO] flashing ${pick(ARTS)} -> ${rnd(82, 100)}%`,
    () => `[ OK ] deploy ${pick(ARTS)} verified crc=0x${hex()}`,
    () => `[INFO] queue depth ${rnd(0, 7)} | ${pick(NODES)} idle`,
    () => `[PASS] thermal ${pick(NODES)} ${rnd(41, 67)}C nominal`,
    () => `[INFO] pll lock ${rnd(2, 9)}us | trim applied`,
    () => `[ OK ] canary ring-${rnd(0, 2)} stable, promoting`,
    () => `[INFO] worker w${rnd(1, 12)} claimed t-${rnd(90000, 99999)}`,
  ];
  const FAIL = [
    () => `[FAIL] regress/${pick(NODES)} timeout @ stage ${rnd(2, 6)}`,
    () => `[FAIL] crc mismatch ${pick(ARTS)} retrying`,
  ];
  function nextLogLine() {
    const fail = Math.random() < 0.08;            // sparing oxide-red accent
    return { text: (fail ? pick(FAIL) : pick(OK))(), accent: fail };
  }

  const lines = []; // {text, accent}, most-recent-last
  function repaintLog() {
    lctx.clearRect(0, 0, LOG_W, LOG_H);
    lctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    lctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      const y = LOG_H - (lines.length - i) * LINE_H; // newest at bottom
      const fade = 0.35 + 0.65 * (i / Math.max(1, lines.length - 1)); // oldest dimmer
      lctx.fillStyle = lines[i].accent
        ? `rgba(214,69,69,${0.85 * fade})`           // #d64545, rare
        : `rgba(170,176,170,${0.78 * fade})`;        // dim CI grey-green
      lctx.fillText(lines[i].text, 8, y);
    }
    // dissolve right edge so line tails don't form a hard block behind the chip
    lctx.globalCompositeOperation = 'destination-out';
    const grad = lctx.createLinearGradient(LOG_W * 0.55, 0, LOG_W, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.6)');
    lctx.fillStyle = grad;
    lctx.fillRect(0, 0, LOG_W, LOG_H);
    lctx.globalCompositeOperation = 'source-over';
    logTex.needsUpdate = true;                      // ONLY here, on change
  }

  let logTimer = null;
  function pushLine() {
    lines.push(nextLogLine());
    if (lines.length > MAX_LINES) lines.shift();
    repaintLog();
    if (!running) renderAll();                      // keep it visible if RAF idle
    logTimer = setTimeout(pushLine, 120 + Math.random() * 140); // 120-260ms band
  }
  function startLog() {
    if (logTimer === null) pushLine();
  }
  function stopLog() {
    if (logTimer !== null) { clearTimeout(logTimer); logTimer = null; }
  }

  function renderAll() {
    renderer.clear();                  // dark base (#0a0a0a) + depth
    renderer.render(bgScene, bgCam);   // faint logs, drawn first
    renderer.render(scene, camera);    // chip on top, always in front
  }

  // ---- helpers ----
  function lineMat(opacity) {
    const m = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity });
    disposables.push(m);
    return m;
  }
  function dashMat(opacity, dashSize = 0.16, gapSize = 0.11) {
    const m = new THREE.LineDashedMaterial({ color: ACCENT, transparent: true, opacity, dashSize, gapSize });
    disposables.push(m);
    return m;
  }
  function wireBox(bw, bh, bd, opacity, dashed) {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, bh, bd));
    disposables.push(edges);
    const mat = dashed ? dashMat(opacity) : lineMat(opacity);
    const seg = new THREE.LineSegments(edges, mat);
    if (dashed) seg.computeLineDistances();
    return seg;
  }

  // ---- substrate + PCB trace grid ----
  const substrate = wireBox(5.6, 0.18, 5.6, 0.32, false);
  substrate.position.y = -0.92;
  root.add(substrate);

  const gridPts = [];
  const gy = -0.83, half = 2.65;
  for (let i = -5; i <= 5; i++) {
    const t = i * 0.53;
    gridPts.push(-half, gy, t, half, gy, t);
    gridPts.push(t, gy, -half, t, gy, half);
  }
  const gridGeom = new THREE.BufferGeometry();
  gridGeom.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  disposables.push(gridGeom);
  root.add(new THREE.LineSegments(gridGeom, lineMat(0.14)));

  // ---- package body ----
  const pkg = wireBox(4.3, 0.46, 4.3, 0.5, false);
  pkg.position.y = -0.58;
  root.add(pkg);

  // ---- silicon die (draws in) + chiplet lattice ----
  const die = wireBox(2.3, 0.34, 2.3, 0.95, true);
  die.position.y = -0.18;
  root.add(die);
  drawMats.push(die.material);

  const chipletGroup = new THREE.Group();
  const cols = 4, rows = 2, gap = 0.56;
  for (let x = 0; x < cols; x++) {
    for (let z = 0; z < rows; z++) {
      const c = wireBox(0.46, 0.24, 0.84, 0.6, true);
      c.position.set((x - (cols - 1) / 2) * gap, -0.18, (z - (rows - 1) / 2) * 1.0);
      chipletGroup.add(c);
      drawMats.push(c.material);
    }
  }
  root.add(chipletGroup);

  // ---- integrated heatspreader + bevelled lip (draws in) ----
  const ihs = wireBox(3.7, 0.3, 3.7, 0.78, true);
  ihs.position.y = 0.28;
  root.add(ihs);
  drawMats.push(ihs.material);

  const lipPts = [];
  const ihsTopY = 0.28 + 0.15, lipY = 0.28 - 0.05;
  const o = 1.85, inn = 1.6;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  corners.forEach(([sx, sz]) => {
    lipPts.push(sx * o, ihsTopY, sz * o, sx * inn, lipY, sz * inn);
  });
  const lipGeom = new THREE.BufferGeometry();
  lipGeom.setAttribute('position', new THREE.Float32BufferAttribute(lipPts, 3));
  disposables.push(lipGeom);
  const lipMat = dashMat(0.7, 0.1, 0.07);
  const lip = new THREE.LineSegments(lipGeom, lipMat);
  lip.computeLineDistances();
  root.add(lip);
  drawMats.push(lipMat);

  const rim = wireBox(3.2, 0.001, 3.2, 0.42, false);
  rim.position.y = ihsTopY;
  root.add(rim);

  // ---- BGA solder-ball array ----
  const bgaGroup = new THREE.Group();
  const ballEdges = new THREE.EdgesGeometry(new THREE.SphereGeometry(0.07, 6, 4));
  disposables.push(ballEdges);
  const bgaMat = lineMat(0.5);
  for (let x = -2.2; x <= 2.2 + 1e-6; x += 0.55) {
    for (let z = -2.2; z <= 2.2 + 1e-6; z += 0.55) {
      const b = new THREE.LineSegments(ballEdges, bgaMat);
      b.position.set(x, -1.08, z);
      bgaGroup.add(b);
    }
  }
  root.add(bgaGroup);

  // ---- dashed bond wires: die corners -> package pads (draws in) ----
  const wirePts = [];
  const dieCorner = [[-1.15, -0.02, -1.15], [1.15, -0.02, -1.15], [1.15, -0.02, 1.15], [-1.15, -0.02, 1.15]];
  const pkgPad = [[-2.15, -0.36, -2.15], [2.15, -0.36, -2.15], [2.15, -0.36, 2.15], [-2.15, -0.36, 2.15]];
  dieCorner.forEach((d, i) => wirePts.push(...d, ...pkgPad[i]));
  const dieMid = [[0, -0.02, -1.15], [1.15, -0.02, 0], [0, -0.02, 1.15], [-1.15, -0.02, 0]];
  const pkgMid = [[0, -0.36, -2.15], [2.15, -0.36, 0], [0, -0.36, 2.15], [-2.15, -0.36, 0]];
  dieMid.forEach((d, i) => wirePts.push(...d, ...pkgMid[i]));

  const wireGeom = new THREE.BufferGeometry();
  wireGeom.setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3));
  disposables.push(wireGeom);
  const wireMat = dashMat(0.85, 0.11, 0.08);
  const bondWires = new THREE.LineSegments(wireGeom, wireMat);
  bondWires.computeLineDistances();
  root.add(bondWires);
  drawMats.push(wireMat);

  // ---- choreographed draw-in: die -> chiplets -> IHS -> lip -> bond wires ----
  const stagger = [{ mat: die.material, start: 0.15, dur: 1.1 }];
  chipletGroup.children.forEach((c, i) => {
    stagger.push({ mat: c.material, start: 0.55 + i * 0.07, dur: 0.85 });
  });
  stagger.push({ mat: ihs.material, start: 1.25, dur: 1.2 });
  stagger.push({ mat: lipMat, start: 1.75, dur: 0.7 });
  stagger.push({ mat: wireMat, start: 2.1, dur: 1.1 });

  drawMats.forEach((m) => { m.dashOffset = reduced ? 0 : TOTAL_DASH; });

  const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
  function applyDraw(t) {
    for (const s of stagger) {
      const k = Math.max(0, Math.min((t - s.start) / s.dur, 1));
      s.mat.dashOffset = TOTAL_DASH * (1 - easeOutCubic(k));
    }
  }

  // ---- sizing ----
  let measured = false; // force one real-size pass before short-circuiting
  function resize() {
    const nw = Math.max(1, mount.clientWidth);
    const nh = Math.max(1, mount.clientHeight);
    if (measured && nw === w && nh === h) return;
    measured = true;
    w = nw; h = nh;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (!running) renderAll();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  // ---- WebGL context loss guards ----
  const onLost = (e) => { e.preventDefault(); stopRaf(); };
  const onRestored = () => { logTex.needsUpdate = true; if (running) startRaf(); else renderAll(); };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  // ---- loop ----
  const clock = new THREE.Clock();
  let elapsed = 0;
  let drewIn = reduced;          // draw-in completed (skipped under reduced motion)
  let running = false;
  let rafId = null;

  // ---- drag-orbit state (layered over the idle spin) ----
  const PITCH_LIMIT = 0.5;       // clamp vertical drag to about +/-0.5 rad
  let dragYaw = 0;               // accumulated yaw offset (unbounded)
  let dragPitch = 0;             // accumulated pitch offset (clamped)
  let dragging = false;
  let activePointer = null;
  let lastX = 0, lastY = 0;
  let velYaw = 0, velPitch = 0;  // release inertia velocities (rad/frame)

  function applyOrbit() {
    root.rotation.y = elapsed * 0.075 + dragYaw;
    root.rotation.x = 0.2 + dragPitch;
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    const dt = clock.getDelta();
    // advance idle time only while the section is the active spinner; when the
    // loop is kept alive purely for a drag/inertia settle, freeze the idle base
    if (running) elapsed += dt;
    if (!drewIn) {
      applyDraw(elapsed);
      if (elapsed > 3.4) drewIn = true; // last stage end (2.1 + 1.1) + slack
    }
    // release inertia: ease out, then let the RAF settle if idle-paused
    if (!dragging && (velYaw !== 0 || velPitch !== 0)) {
      dragYaw += velYaw;
      dragPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, dragPitch + velPitch));
      velYaw *= 0.92;
      velPitch *= 0.92;
      if (Math.abs(velYaw) < 1e-4) velYaw = 0;
      if (Math.abs(velPitch) < 1e-4) velPitch = 0;
      if (velYaw === 0 && velPitch === 0 && !running) { stopRaf(); }
    }
    applyOrbit();
    renderAll();
  }

  function startRaf() {
    if (rafId !== null) return;
    clock.getDelta(); // discard gap so timing stays smooth
    rafId = requestAnimationFrame(frame);
  }
  function stopRaf() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ---- click-drag orbit (skipped entirely under reduced motion) ----
  function onPointerDown(e) {
    if (activePointer !== null) return;
    activePointer = e.pointerId;
    dragging = true;
    velYaw = 0; velPitch = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    startRaf(); // ensure a live loop while dragging even if idle-paused
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!dragging || e.pointerId !== activePointer) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const yawStep = dx * 0.0085;
    const pitchStep = dy * 0.0085;
    dragYaw += yawStep;
    dragPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, dragPitch + pitchStep));
    velYaw = yawStep;   // seed inertia from the latest motion
    velPitch = pitchStep;
    if (!running && rafId === null) startRaf();
    e.preventDefault();
  }
  function endDrag(e) {
    if (e.pointerId !== activePointer) return;
    dragging = false;
    activePointer = null;
    canvas.style.cursor = 'grab';
    try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    // inertia continues in frame(); if no velocity and idle-paused, settle now
    if (!running && velYaw === 0 && velPitch === 0) stopRaf();
  }
  function onPointerCancel(e) { endDrag(e); }

  if (!reduced) {
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onPointerDown, false);
    canvas.addEventListener('pointermove', onPointerMove, false);
    canvas.addEventListener('pointerup', endDrag, false);
    canvas.addEventListener('pointercancel', onPointerCancel, false);
  }

  if (reduced) {
    // static log frame: fill the buffer once, paint once, NO timer/listener.
    for (let i = 0; i < MAX_LINES; i++) lines.push(nextLogLine());
    repaintLog();
    applyDraw(1e9);
    root.rotation.y = 0.35;
    renderAll();
    // Re-measure after layout so an offscreen/0-width card renders at correct aspect.
    requestAnimationFrame(() => { resize(); renderAll(); });
  }

  let disposed = false;

  return {
    start() {
      if (reduced || running) return;
      resize(); // force a real-size pass before the first start frame
      running = true;
      startLog();
      startRaf();
    },
    stop() {
      if (!running) return;
      running = false;
      stopLog();
      stopRaf();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      this.stop();
      // release pointer capture if a drag is still active, then settle the loop
      if (activePointer !== null) {
        try { if (canvas.hasPointerCapture(activePointer)) canvas.releasePointerCapture(activePointer); } catch (_) {}
        activePointer = null;
        dragging = false;
      }
      velYaw = 0; velPitch = 0;
      stopLog();
      stopRaf();
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
      if (!reduced) {
        canvas.removeEventListener('pointerdown', onPointerDown, false);
        canvas.removeEventListener('pointermove', onPointerMove, false);
        canvas.removeEventListener('pointerup', endDrag, false);
        canvas.removeEventListener('pointercancel', onPointerCancel, false);
      }
      disposables.forEach((d) => d.dispose && d.dispose());
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      renderer.dispose();
    },
  };
}
