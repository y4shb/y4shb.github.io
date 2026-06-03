import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// EXPERIENCE: floating MI450 die. Runs only when the AMD tab is active AND the
// section is onscreen (started). Ported from demos/final/t08-a.html.

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);
  scene.fog = new THREE.Fog(0x0a0a0a, 6.5, 17);

  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  const camHome = new THREE.Vector3(0, 0.62, 4.25);
  camera.position.copy(camHome);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0x1a1c22, 0.30));

  const key = new THREE.DirectionalLight(0xffd9b0, 1.7);
  key.position.set(3.2, 4.2, 2.2);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x7088ff, 0.55);
  fill.position.set(-3.6, 1.4, 1.6);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xd64545, 1.5);
  rim.position.set(-0.5, 2.2, -4.0);
  scene.add(rim);

  const accentPt = new THREE.PointLight(0xd64545, 4.0, 7, 2);
  accentPt.position.set(0, 0.55, 1.4);
  scene.add(accentPt);

  const chip = new THREE.Group();
  scene.add(chip);

  const subMat = new THREE.MeshPhysicalMaterial({
    color: 0x0d0d10, roughness: 0.62, metalness: 0.25,
    clearcoat: 0.35, clearcoatRoughness: 0.55,
  });
  const substrate = new THREE.Mesh(new THREE.BoxGeometry(2.42, 0.10, 2.42), subMat);
  substrate.position.y = -0.205;
  chip.add(substrate);

  const rimMat = new THREE.MeshPhysicalMaterial({
    color: 0x161619, roughness: 0.45, metalness: 0.6, clearcoat: 0.5,
  });
  const subTrace = new THREE.Mesh(new THREE.BoxGeometry(2.18, 0.012, 2.18), rimMat);
  subTrace.position.y = -0.15;
  chip.add(subTrace);

  const dieMat = new THREE.MeshPhysicalMaterial({
    color: 0x15151a, roughness: 0.26, metalness: 0.9,
    clearcoat: 1.0, clearcoatRoughness: 0.16, reflectivity: 0.65,
    envMapIntensity: 1.15,
  });
  const die = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.26, 2.0), dieMat);
  die.position.y = -0.035;
  chip.add(die);

  const tileGroup = new THREE.Group();
  chip.add(tileGroup);

  const tileMatDark = new THREE.MeshPhysicalMaterial({
    color: 0x1e1e23, roughness: 0.40, metalness: 0.72,
    clearcoat: 0.6, clearcoatRoughness: 0.22, envMapIntensity: 1.0,
  });
  const tileMatHot = new THREE.MeshPhysicalMaterial({
    color: 0x4a1518, emissive: 0xd64545, emissiveIntensity: 0.6,
    roughness: 0.34, metalness: 0.55, clearcoat: 0.45,
  });
  const tileMatMid = new THREE.MeshPhysicalMaterial({
    color: 0x281315, emissive: 0xd64545, emissiveIntensity: 0.16,
    roughness: 0.38, metalness: 0.62, clearcoat: 0.5,
  });

  const N = 6, gap = 0.045, span = 1.80;
  const cell = (span - gap * (N - 1)) / N;
  const hotSet = new Set(['1,1', '1,4', '2,2', '3,3', '4,1', '4,4']);
  const midSet = new Set(['0,2', '2,5', '5,3', '3,0', '1,3', '4,2']);
  const tileGeo = new THREE.BoxGeometry(cell, 0.055, cell);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const k = i + ',' + j;
      const mat = hotSet.has(k) ? tileMatHot : (midSet.has(k) ? tileMatMid : tileMatDark);
      const tile = new THREE.Mesh(tileGeo, mat);
      tile.position.set(
        -span / 2 + cell / 2 + i * (cell + gap),
        0.115,
        -span / 2 + cell / 2 + j * (cell + gap)
      );
      tileGroup.add(tile);
    }
  }

  const barMat = new THREE.MeshPhysicalMaterial({
    color: 0xd64545, emissive: 0xd64545, emissiveIntensity: 0.5,
    roughness: 0.42, metalness: 0.4, clearcoat: 0.3,
  });
  const accentBar = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.014, 0.055), barMat);
  accentBar.position.set(0, 0.148, 0.86);
  chip.add(accentBar);

  const etchMat = new THREE.MeshPhysicalMaterial({
    color: 0x2a2a30, roughness: 0.5, metalness: 0.5, clearcoat: 0.4,
  });
  const etchLine = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.010, 0.030), etchMat);
  etchLine.position.set(0, 0.146, 0.95);
  chip.add(etchLine);

  const pinMat = new THREE.MeshStandardMaterial({
    color: 0xc4a26a, roughness: 0.4, metalness: 1.0, envMapIntensity: 1.2,
  });
  const pinGeo = new THREE.SphereGeometry(0.026, 12, 8);
  const PIN_N = 14;
  const pins = new THREE.InstancedMesh(pinGeo, pinMat, PIN_N * PIN_N);
  pins.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const m4 = new THREE.Matrix4();
  const pinSpan = 2.08, pinStep = pinSpan / (PIN_N - 1);
  let pi = 0;
  for (let i = 0; i < PIN_N; i++) {
    for (let j = 0; j < PIN_N; j++) {
      m4.makeTranslation(-pinSpan / 2 + i * pinStep, -0.275, -pinSpan / 2 + j * pinStep);
      pins.setMatrixAt(pi++, m4);
    }
  }
  pins.instanceMatrix.needsUpdate = true;
  chip.add(pins);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: 0x070708, roughness: 0.96, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.15;
  scene.add(floor);

  // --- interaction (pointer parallax scoped to mount) ---
  const ptr = new THREE.Vector2(0, 0);
  const ptrTarget = new THREE.Vector2(0, 0);
  const ZERO2 = new THREE.Vector2(0, 0);

  function onPointerMove(e) {
    const r = mount.getBoundingClientRect();
    if (!r.width || !r.height) return;
    ptrTarget.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ptrTarget.y = ((e.clientY - r.top) / r.height) * 2 - 1;
  }
  function onPointerLeave() { ptrTarget.set(0, 0); }

  if (!reduced) {
    mount.addEventListener('pointermove', onPointerMove, { passive: true });
    mount.addEventListener('pointerleave', onPointerLeave);
  }

  // --- click-drag orbit (layered over the cursor parallax) ---
  // Horizontal drag accumulates yaw (unbounded); vertical drag tilts pitch,
  // clamped to ~+/-0.5 rad. While dragging we suppress the cursor parallax so
  // the drag fully owns the view; on release we add eased-out inertia that the
  // RAF lets settle to zero. All rotation is applied to the `chip` group.
  const DRAG_PITCH_CLAMP = 0.5;     // rad
  const DRAG_YAW_SENS = 0.006;      // rad per px
  const DRAG_PITCH_SENS = 0.006;    // rad per px
  let dragYaw = 0;                  // accumulated yaw applied to chip
  let dragPitch = 0;                // clamped pitch applied to chip
  let dragging = false;
  let dragPointerId = -1;
  let lastDragX = 0, lastDragY = 0;
  let velYaw = 0, velPitch = 0;     // release inertia (rad per frame-ish)
  const canvas = renderer.domElement;

  function onDragDown(e) {
    if (dragging) return;
    dragging = true;
    dragPointerId = e.pointerId;
    lastDragX = e.clientX;
    lastDragY = e.clientY;
    velYaw = 0;
    velPitch = 0;
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    // A drag during a paused (non-running) state should still update the frame.
    if (!running) renderOnce();
  }
  function onDragMove(e) {
    if (!dragging || e.pointerId !== dragPointerId) return;
    const dx = e.clientX - lastDragX;
    const dy = e.clientY - lastDragY;
    lastDragX = e.clientX;
    lastDragY = e.clientY;
    dragYaw += dx * DRAG_YAW_SENS;
    dragPitch = THREE.MathUtils.clamp(dragPitch + dy * DRAG_PITCH_SENS, -DRAG_PITCH_CLAMP, DRAG_PITCH_CLAMP);
    velYaw = dx * DRAG_YAW_SENS;
    velPitch = dy * DRAG_PITCH_SENS;
    if (!running) renderOnce();
  }
  function endDrag(e) {
    if (!dragging || (e && e.pointerId !== dragPointerId)) return;
    dragging = false;
    canvas.style.cursor = 'grab';
    try { if (canvas.hasPointerCapture(dragPointerId)) canvas.releasePointerCapture(dragPointerId); } catch (_) {}
    dragPointerId = -1;
    // If paused, nudge a one-shot frame so any residual inertia is reflected;
    // the running RAF handles inertia naturally when active.
    if (!running) renderOnce();
  }

  if (!reduced) {
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', onDragDown);
    canvas.addEventListener('pointermove', onDragMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  function resize() {
    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();

  const ro = new ResizeObserver(() => {
    resize();
    if (!running) renderOnce(); // keep the static frame crisp when paused
  });
  ro.observe(mount);

  function rebuildEnv() {
    if (envTex) envTex.dispose();
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
  }

  // Named (not inline) so dispose() can remove them and free the GL context.
  function onContextLost(e) { e.preventDefault(); stop(); }
  function onContextRestored() {
    rebuildEnv();
    resize();
    evaluate();
    if (!running) renderOnce();
  }
  renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false);

  // --- animation ---
  const MAX_YAW = THREE.MathUtils.degToRad(30);
  const MAX_PITCH = THREE.MathUtils.degToRad(15);
  const ORBIT_R = 4.25;
  const BREATHE = (Math.PI * 2) / 4;
  const clock = new THREE.Clock(false);

  // Read the selected tab from the DOM so we don't desync from the markup.
  let activeTab = document.querySelector('.exp-tab[aria-selected="true"]')?.dataset.tab || 'amd';
  let started = false;     // observer/section gate
  let running = false;     // RAF actually spinning
  let rafId = 0;
  let elapsed = 0;
  let disposed = false;    // set in dispose(); guards stray one-shot rAFs

  function frame(t) {
    chip.position.y = Math.sin(t * BREATHE) * 0.05;

    // Release inertia: when not actively dragging, decay the residual velocity
    // and fold it into the accumulated rotation, easing out to a settle.
    if (!dragging && (velYaw !== 0 || velPitch !== 0)) {
      dragYaw += velYaw;
      dragPitch = THREE.MathUtils.clamp(dragPitch + velPitch, -DRAG_PITCH_CLAMP, DRAG_PITCH_CLAMP);
      velYaw *= 0.92;
      velPitch *= 0.92;
      if (Math.abs(velYaw) < 1e-4) velYaw = 0;
      if (Math.abs(velPitch) < 1e-4) velPitch = 0;
    }
    // Drag orbit on the chip group, layered over the idle z-wobble.
    chip.rotation.y = dragYaw;
    chip.rotation.x = dragPitch;
    chip.rotation.z = Math.sin(t * 0.4) * 0.012;

    if (reduced) {
      ptr.set(0.4, -0.35);
      ptrTarget.copy(ptr);
    } else if (dragging) {
      // Drag fully owns the view: ease the parallax back to neutral.
      ptr.lerp(ZERO2, 0.12);
    } else {
      ptr.lerp(ptrTarget, 0.055);
    }
    const yaw = -ptr.x * MAX_YAW;
    const pitch = -ptr.y * MAX_PITCH;
    camera.position.x = Math.sin(yaw) * ORBIT_R;
    camera.position.z = Math.cos(yaw) * ORBIT_R;
    camera.position.y = camHome.y + Math.sin(pitch) * 1.45;
    camera.lookAt(0, 0, 0);

    tileMatHot.emissiveIntensity = 0.5 + Math.sin(t * 1.7) * 0.14;
    accentBar.material.emissiveIntensity = 0.46 + Math.sin(t * 1.7 + 0.6) * 0.08;

    renderer.render(scene, camera);
  }

  function renderOnce() { frame(elapsed); }

  function loop() {
    rafId = requestAnimationFrame(loop);
    elapsed = clock.getElapsedTime();
    frame(elapsed);
  }

  // RAF spins only when started AND the AMD tab is active (and not reduced).
  function evaluate() {
    const want = started && activeTab === 'amd' && !reduced;
    if (want && !running) {
      running = true;
      clock.start();
      loop();
    } else if (!want && running) {
      running = false;
      clock.stop();
      cancelAnimationFrame(rafId);
    }
  }

  function onTab(e) {
    if (!e || !e.detail) return;
    activeTab = e.detail.name;
    evaluate();
  }
  document.addEventListener('exp:tab', onTab);

  function start() {
    if (started) return;
    started = true;
    if (reduced) {
      // Defer so mount has layout (clientWidth/Height non-zero) before sizing.
      requestAnimationFrame(() => { if (disposed) return; resize(); renderOnce(); });
      return;
    }
    evaluate();
  }

  function stop() {
    if (!started) { if (running) { running = false; clock.stop(); cancelAnimationFrame(rafId); } return; }
    started = false;
    evaluate();
  }

  function dispose() {
    if (disposed) return; // idempotent: a second call (or stray rAF) is a safe no-op
    disposed = true;
    // Full teardown so repeated bfcache cycles cannot exhaust the browser's
    // WebGL context pool (mirrors proj-dcauto's dispose contract).
    document.removeEventListener('exp:tab', onTab);
    stop();                       // cancels the RAF and stops the clock
    ro.disconnect();
    if (!reduced) {
      mount.removeEventListener('pointermove', onPointerMove);
      mount.removeEventListener('pointerleave', onPointerLeave);
      // Release any in-progress drag capture before tearing the canvas down.
      if (dragging && dragPointerId !== -1) {
        try { if (canvas.hasPointerCapture(dragPointerId)) canvas.releasePointerCapture(dragPointerId); } catch (_) {}
      }
      dragging = false;
      canvas.removeEventListener('pointerdown', onDragDown);
      canvas.removeEventListener('pointermove', onDragMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
    }
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
    // Free every GPU resource: geometries + materials in the scene graph (plus the
    // instanced pin buffers), then the PMREM env map, its generator, and finally
    // the renderer and its WebGL context.
    scene.traverse((obj) => {
      if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((mm) => mm && mm.dispose && mm.dispose());
      else if (m && m.dispose) m.dispose();
      if (obj.isInstancedMesh && obj.dispose) obj.dispose();
    });
    if (envTex) envTex.dispose();
    pmrem.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  // Defer the initial static frame until the mount has real layout, otherwise
  // the first render clamps to a 1x1 aspect and squashes the chip.
  if (reduced) requestAnimationFrame(() => { if (disposed) return; resize(); renderOnce(); });

  return { start, stop, dispose };
}
