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
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  mount.appendChild(canvas);

  const root = new THREE.Group();
  root.rotation.x = 0.2;
  scene.add(root);

  // ---- helpers ----
  const drawMats = [];
  const disposables = [];

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
    if (!running) renderer.render(scene, camera);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  // ---- WebGL context loss guards ----
  const onLost = (e) => { e.preventDefault(); stopRaf(); };
  const onRestored = () => { if (running) startRaf(); else renderer.render(scene, camera); };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  // ---- loop ----
  const clock = new THREE.Clock();
  let elapsed = 0;
  let drewIn = reduced;          // draw-in completed (skipped under reduced motion)
  let running = false;
  let rafId = null;

  function frame() {
    rafId = requestAnimationFrame(frame);
    const dt = clock.getDelta();
    elapsed += dt;
    if (!drewIn) {
      applyDraw(elapsed);
      if (elapsed > 3.4) drewIn = true; // last stage end (2.1 + 1.1) + slack
    }
    root.rotation.y = elapsed * 0.075;
    renderer.render(scene, camera);
  }

  function startRaf() {
    if (rafId !== null) return;
    clock.getDelta(); // discard gap so timing stays smooth
    rafId = requestAnimationFrame(frame);
  }
  function stopRaf() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  if (reduced) {
    applyDraw(1e9);
    root.rotation.y = 0.35;
    renderer.render(scene, camera);
    // Re-measure after layout so an offscreen/0-width card renders at correct aspect.
    requestAnimationFrame(() => { resize(); renderer.render(scene, camera); });
  }

  let disposed = false;

  return {
    start() {
      if (reduced || running) return;
      resize(); // force a real-size pass before the first start frame
      running = true;
      startRaf();
    },
    stop() {
      if (!running) return;
      running = false;
      stopRaf();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      this.stop();
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
      disposables.forEach((d) => d.dispose && d.dispose());
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      renderer.dispose();
    },
  };
}
