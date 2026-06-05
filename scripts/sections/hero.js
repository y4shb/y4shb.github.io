// Real headshot, same-origin (Yash.jpg sits beside index.html) so getImageData never taints.
const PORTRAIT_SRC = 'Yash.jpg';

// Palette (kept local; only --accent is colored)
const C = {
  bg: '#0a0a0a', surface: '#141414', surface2: '#1c1c1f',
  accent: '#d64545', text: '#ededed', muted: '#8a8f98',
  // faint matches --faint in tokens.css; #7c818a clears WCAG AA (5.06:1 on --bg).
  faint: '#7c818a', border: '#1f1f22',
};

const COMMAND = '$ cat ~/.face | ascii';
// Clean, evenly-stepped ramp (dark -> dense) reads better than a punctuation-heavy one.
const RAMP = " .:-=+*#%@";
// Portrait box aspect (matches .hv2-portrait aspect-ratio:4/5 and object-fit:cover).
const BOX_W = 4, BOX_H = 5;
const ADV = 0.6; // mono glyph advance (width/height): used for grid rows + cover fit

// High-res column count, scaled down on narrow viewports for performance.
function pickCols() {
  const w = window.innerWidth || 1280;
  if (w < 480) return 48;
  if (w < 820) return 64;
  return 162;
}

const STYLE_ID = 'hero-v2-style';

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.hero-mount{width:100%;display:flex;align-items:center;justify-content:center;padding:clamp(16px,4vw,56px);}
.hv2-term{width:min(1180px,100%);background:${C.surface};border:1px solid ${C.border};border-radius:14px;overflow:hidden;box-shadow:0 40px 120px -50px rgba(0,0,0,.95),0 1px 0 0 rgba(255,255,255,.025) inset;font-family:'Geist Mono',ui-monospace,Menlo,monospace;}
.hv2-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#101012;border-bottom:1px solid ${C.border};user-select:none;}
.hv2-dots{display:flex;gap:8px;}
.hv2-dot{width:12px;height:12px;border-radius:50%;}
.hv2-dot--r{background:#e0443e;}.hv2-dot--y{background:#dea123;}.hv2-dot--g{background:#1aab29;}
.hv2-title{flex:1;text-align:center;font-size:12px;color:${C.faint};letter-spacing:.02em;margin-right:52px;}
.hv2-body{padding:clamp(18px,2.6vw,34px) clamp(18px,3vw,40px) clamp(24px,3.4vw,44px);font-size:13px;color:${C.text};}
.hv2-cmd{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:clamp(18px,3vw,30px);}
.hv2-cmd-text{color:${C.text};white-space:pre;}
.hv2-caret{display:inline-block;width:8px;height:1.05em;transform:translateY(2px);margin-left:1px;background:${C.accent};animation:hv2blink 1s steps(1) infinite;}
@keyframes hv2blink{50%{opacity:0;}}
@media (prefers-reduced-motion: reduce){.hv2-caret,.hv2-copy .hero-title .hero-dot{animation:none;background:transparent;color:inherit;display:inline;height:auto;line-height:inherit;}
/* reduced-motion: the animated reveal is disabled, so show the real photo statically (the ascii overlay drops away) */
.hv2-portrait.rm-static .hv2-photo{opacity:1;}
.hv2-portrait.rm-static .hv2-ascii{opacity:0;}
.hv2-portrait{cursor:default;}}
.hv2-out{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(24px,3vw,48px);align-items:center;}
.hv2-out .hero-fallback{display:contents;}
.hv2-copy{}
.hv2-copy .hero-eyebrow{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:${C.accent};margin:0 0 clamp(10px,1.6vw,14px);}
.hv2-copy .hero-name{font-family:'Geist',system-ui,sans-serif;font-size:clamp(15px,1.5vw,17px);font-weight:500;letter-spacing:-.01em;color:${C.text};margin:0 0 clamp(16px,2.4vw,24px);}
.hv2-copy .hero-name .sep{color:${C.faint};margin:0 .35em;font-weight:400;}
.hv2-copy .hero-title{font-family:'Geist',system-ui,sans-serif;font-size:clamp(38px,6.4vw,76px);font-weight:600;letter-spacing:-.035em;line-height:.98;color:${C.text};margin:0 0 clamp(16px,2.4vw,22px);}
.hv2-copy .hero-title .accent{color:${C.accent};}
.hv2-copy .hero-title .hero-dot{display:inline-block;width:.075em;height:.78em;line-height:.78em;vertical-align:-.02em;background:${C.accent};color:transparent;border-radius:1px;overflow:hidden;animation:hv2dotblink 1.15s steps(1) infinite;}
@keyframes hv2dotblink{0%,50%{background:${C.accent};}50.01%,100%{background:transparent;}}
.hv2-copy .hero-tagline{font-family:'Geist',system-ui,sans-serif;font-size:clamp(15px,1.7vw,18px);color:${C.text};opacity:.86;max-width:56ch;line-height:1.5;margin:0 0 clamp(26px,3.4vw,36px);}
.hv2-copy .hero-cta{display:flex;flex-wrap:wrap;gap:10px;}
.hv2-copy .hero-cta a{font-family:'Geist Mono',ui-monospace,monospace;font-size:12.5px;letter-spacing:.02em;color:${C.muted};text-decoration:none;padding:9px 15px;border:1px solid ${C.border};background:${C.surface2};border-radius:8px;transition:color .18s ease,border-color .18s ease,background .18s ease;}
.hv2-copy .hero-cta a:hover{color:${C.text};border-color:${C.accent};background:#201a1a;}
.hv2-copy .hero-cta a:focus-visible{color:${C.text};border-color:${C.accent};background:#201a1a;outline:2px solid ${C.accent};outline-offset:2px;}
.hv2-portrait{position:relative;width:100%;max-width:380px;aspect-ratio:4/5;margin-inline:auto;border:none;border-radius:0;overflow:hidden;background:${C.surface};justify-self:center;cursor:crosshair;touch-action:none;--radius:0px;--rmax:130px;}
.hv2-portrait:focus-visible{outline:2px solid ${C.accent};outline-offset:3px;}
.hv2-layer{position:absolute;inset:0;width:100%;height:100%;}
.hv2-photo{object-fit:cover;filter:grayscale(1) contrast(1.05) brightness(.92);opacity:0;transition:opacity .4s ease;}
.hv2-ascii{display:block;margin:0;color:${C.accent};background:${C.surface};font-family:'Geist Mono',ui-monospace,monospace;font-weight:500;white-space:pre;user-select:none;pointer-events:none;overflow:hidden;opacity:1;transition:opacity .3s ease;-webkit-mask-image:radial-gradient(circle var(--radius,0px) at var(--mx,50%) var(--my,50%),transparent 0,transparent 54%,rgba(0,0,0,.6) 78%,#000 100%);mask-image:radial-gradient(circle var(--radius,0px) at var(--mx,50%) var(--my,50%),transparent 0,transparent 54%,rgba(0,0,0,.6) 78%,#000 100%);}
@media (hover: hover){.hv2-portrait.has-photo:hover .hv2-photo{opacity:1;}}
.hv2-portrait.has-photo.is-revealed .hv2-photo{opacity:1;}
.hv2-portrait.has-photo.is-revealed .hv2-ascii{opacity:0;}
.hv2-portrait.rm-static .hv2-photo{opacity:1;}
.hv2-portrait.rm-static .hv2-ascii{opacity:0;}
.hv2-grain{display:none;}
.hv2-caption{position:absolute;left:13px;bottom:11px;font-family:'Geist Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:${C.faint};pointer-events:none;}
.hv2-caption b{color:${C.accent};font-weight:500;}
.hv2-reveal{opacity:0;transform:translateY(4px);}
.hv2-out.is-on .hv2-reveal{animation:hv2lineIn 420ms ease forwards;}
@keyframes hv2lineIn{to{opacity:1;transform:none;}}
@media (max-width:820px){.hv2-out{grid-template-columns:1fr;gap:clamp(28px,6vw,40px);}.hv2-portrait{order:-1;max-width:320px;justify-self:center;}.hv2-copy .hero-tagline{max-width:none;}}
`;
  document.head.appendChild(s);
}

export default function init(mount, ctx) {
  const reduced = !!(ctx && ctx.reducedMotion);
  const noHover = window.matchMedia('(hover: none)').matches;

  injectStyle();

  // ---- build terminal shell inside mount ----
  const term = document.createElement('main');
  term.className = 'hv2-term';
  term.setAttribute('aria-label', 'terminal: yash@y4sh');

  const bar = document.createElement('div');
  bar.className = 'hv2-bar';
  const dots = document.createElement('div');
  dots.className = 'hv2-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (const k of ['r', 'y', 'g']) {
    const d = document.createElement('span');
    d.className = 'hv2-dot hv2-dot--' + k;
    dots.appendChild(d);
  }
  const title = document.createElement('div');
  title.className = 'hv2-title';
  title.textContent = 'yash@y4sh: ~';
  bar.append(dots, title);

  const body = document.createElement('div');
  body.className = 'hv2-body';

  // command line
  const cmd = document.createElement('div');
  cmd.className = 'hv2-cmd';
  const cmdText = document.createElement('span');
  cmdText.className = 'hv2-cmd-text';
  const caret = document.createElement('span');
  caret.className = 'hv2-caret';
  caret.setAttribute('aria-hidden', 'true');
  cmd.append(cmdText, caret);
  // Under reduced motion there is no typing/blink window, so hide the caret now.
  if (reduced) caret.style.display = 'none';

  // output grid
  const out = document.createElement('div');
  out.className = 'hv2-out';

  // copy side: reuse the existing .hero-fallback node (move it in, do not duplicate)
  const copy = document.createElement('div');
  copy.className = 'hv2-copy';
  const fallback = mount.querySelector('.hero-fallback');
  if (fallback) {
    copy.appendChild(fallback);
  } else {
    // defensive: build minimal copy if markup missing
    const eb = document.createElement('p');
    eb.className = 'hero-eyebrow';
    eb.textContent = 'SOFTWARE ENGINEER · SCIENCE-FICTION NERD · STUDENT OF LIFE';
    copy.appendChild(eb);
  }

  // Capture the copy lines so they can be typed out terminal-style, then clear
  // them (only when motion is allowed) so they stream in instead of flashing full.
  const eyebrowEl = copy.querySelector('.hero-eyebrow');
  const titleEl = copy.querySelector('.hero-title');
  const taglineEl = copy.querySelector('.hero-tagline');
  const ctaEl = copy.querySelector('.hero-cta');
  const typeTargets = [eyebrowEl, titleEl, taglineEl].filter(Boolean).map((el) => ({
    el,
    html: el.innerHTML,
    // Keep deep clones of the original children so an aborted reveal can be
    // restored with replaceChildren (already-parsed nodes, no HTML re-parsing).
    nodes: [...el.childNodes].map((n) => n.cloneNode(true)),
  }));
  if (!reduced) {
    typeTargets.forEach((t) => { t.el.textContent = ''; });
    if (ctaEl) ctaEl.style.opacity = '0';
  }

  // portrait side. Focusable + role=img so keyboard/AT users can reach and
  // understand it; Enter/Space toggle the reveal (wired below).
  const portrait = document.createElement('div');
  portrait.className = 'hv2-portrait hv2-reveal';
  portrait.setAttribute('role', 'img');
  portrait.setAttribute('aria-label', 'ASCII portrait of Yash Bhardwaj. Activate to reveal the photo.');
  if (!reduced) portrait.setAttribute('tabindex', '0');

  const photo = document.createElement('img');
  photo.className = 'hv2-layer hv2-photo';
  photo.alt = 'Portrait of Yash Bhardwaj';
  // Same-origin asset; no crossOrigin needed and the canvas stays untainted.

  const ascii = document.createElement('pre');
  ascii.className = 'hv2-layer hv2-ascii';
  ascii.setAttribute('aria-hidden', 'true');

  const grain = document.createElement('div');
  grain.className = 'hv2-grain';
  grain.setAttribute('aria-hidden', 'true');

  // Caption invites interaction; wording differs for touch vs hover devices.
  const caption = document.createElement('div');
  caption.className = 'hv2-caption';
  caption.setAttribute('aria-hidden', 'true');
  const cb = document.createElement('b');
  cb.textContent = '//';
  caption.append(cb, document.createTextNode(noHover ? ' tap to reveal' : ' hover to reveal'));

  portrait.append(photo, ascii, grain, caption);

  out.append(copy, portrait);
  body.append(cmd, out);
  term.append(bar, body);
  mount.appendChild(term);
  // Re-fit once the terminal has a real layout box (ResizeObserver may have
  // already fired before content existed and early-returned).
  requestAnimationFrame(() => { if (!disposed) fitAscii(); });

  // offscreen sampling canvas
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  // ---- state ----
  let rows = 0;
  let cols = pickCols();
  let built = false;
  let rafId = 0;
  let running = false;
  let disposed = false;
  let bitmapReady = false;
  let typeTimer = 0;
  const target = { x: 0.5, y: 0.5 };
  const cur = { x: 0.5, y: 0.5 };
  // openness in [0,1]: 0 = pure ascii (no photo hole), 1 = full reveal radius.
  let openness = 0;
  let openTarget = 0;
  let rmax = 130; // fully-open reveal radius in px (set in fitAscii)
  // held = a persistent reveal latched by a tap (touch) or Enter/Space (keyboard),
  // independent of pointer presence. Stays open until toggled off again.
  let held = false;
  // one-time auto-reveal sweep state (teaches visitors a photo hides under the ascii)
  let sweepDone = false;
  let sweeping = false;
  let sweepStart = 0;
  const SWEEP_MS = 1700;

  // Compute the cover-crop rect of a srcW x srcH source for the BOX_W:BOX_H box
  // (mirrors object-fit:cover) so the ascii samples the SAME region the photo
  // shows, keeping reveal and glyphs aligned region-for-region.
  function coverCrop(srcW, srcH) {
    const boxAR = BOX_W / BOX_H;
    const srcAR = srcW / srcH;
    let sw, sh;
    if (srcAR > boxAR) {
      // source wider than box: crop sides
      sh = srcH;
      sw = srcH * boxAR;
    } else {
      // source taller than box: crop top/bottom
      sw = srcW;
      sh = srcW / boxAR;
    }
    const sx = (srcW - sw) / 2;
    const sy = (srcH - sh) / 2;
    return { sx, sy, sw, sh };
  }

  // ---- ascii generation ----
  // Samples the cropped region [sx,sy,sw,sh] of `work` into `cols` x rows cells.
  // rows derive from the BOX aspect (not the raw image) so the grid matches the
  // 4:5 portrait box the photo fills.
  function sampleCanvas(sx, sy, sw, sh) {
    cols = pickCols();
    // rows chosen so the glyph grid aspect equals the 4:5 box: the ascii fills the
    // container edge to edge (no letterbox) and the portrait stays undistorted.
    rows = Math.max(8, Math.round(cols * ADV * (BOX_H / BOX_W)));
    const tmp = document.createElement('canvas');
    tmp.width = cols;
    tmp.height = rows;
    const t = tmp.getContext('2d', { willReadFrequently: true });
    t.drawImage(work, sx, sy, sw, sh, 0, 0, cols, rows);

    let data;
    try {
      data = t.getImageData(0, 0, cols, rows).data;
    } catch (err) {
      return false; // tainted canvas (CORS); caller falls back
    }

    const last = RAMP.length - 1;
    // Black-clip + contrast: collapse the dark studio background to spaces so the
    // lit subject (face, shoulders) reads cleanly. Background detail is intentionally
    // dropped. Tuned for the near-black Yash.jpg headshot.
    const BLACK = 0.24, WHITE = 0.88, GAMMA = 0.80;
    const span = WHITE - BLACK;
    const lines = [];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
        let v = (lum - BLACK) / span;
        v = v <= 0 ? 0 : (v >= 1 ? 1 : Math.pow(v, GAMMA));
        line += RAMP[Math.round(v * last)];
      }
      lines.push(line);
    }
    ascii.textContent = lines.join('\n');
    built = true;
    fitAscii();
    return true;
  }

  function buildFromPhoto() {
    const w = photo.naturalWidth, h = photo.naturalHeight;
    if (!w || !h) return false;
    bitmapReady = true;
    work.width = w;
    work.height = h;
    wctx.clearRect(0, 0, w, h);
    try {
      wctx.drawImage(photo, 0, 0, w, h);
    } catch (err) {
      return false;
    }
    const c = coverCrop(w, h);
    return sampleCanvas(c.sx, c.sy, c.sw, c.sh);
  }

  // procedural head-and-shoulders so the portrait is never blank
  function buildSilhouette() {
    const W = 600, H = 800;
    work.width = W;
    work.height = H;

    const bg = wctx.createRadialGradient(W * 0.5, H * 0.42, 40, W * 0.5, H * 0.5, H * 0.75);
    bg.addColorStop(0, '#2a2a2a');
    bg.addColorStop(1, '#070707');
    wctx.fillStyle = bg;
    wctx.fillRect(0, 0, W, H);

    wctx.fillStyle = '#3a3a3a';
    wctx.beginPath();
    wctx.moveTo(W * 0.12, H);
    wctx.bezierCurveTo(W * 0.18, H * 0.66, W * 0.34, H * 0.6, W * 0.5, H * 0.6);
    wctx.bezierCurveTo(W * 0.66, H * 0.6, W * 0.82, H * 0.66, W * 0.88, H);
    wctx.closePath();
    wctx.fill();

    const head = wctx.createRadialGradient(W * 0.42, H * 0.3, 30, W * 0.5, H * 0.36, 240);
    head.addColorStop(0, '#6a6a6a');
    head.addColorStop(1, '#2c2c2c');
    wctx.fillStyle = head;
    wctx.fillRect(W * 0.43, H * 0.46, W * 0.14, H * 0.12);
    wctx.beginPath();
    wctx.ellipse(W * 0.5, H * 0.34, W * 0.18, H * 0.21, 0, 0, Math.PI * 2);
    wctx.fill();

    portrait.classList.remove('has-photo');
    const c = coverCrop(W, H);
    sampleCanvas(c.sx, c.sy, c.sw, c.sh);
  }

  function buildPortrait() {
    if (buildFromPhoto()) {
      portrait.classList.add('has-photo');
    } else {
      buildSilhouette();
    }
    // Reduced motion: the animated reveal is off, so present the real photo
    // statically (rm-static shows the photo and hides the ascii overlay).
    if (reduced && portrait.classList.contains('has-photo')) {
      portrait.classList.add('rm-static');
    }
  }

  // One-time teaching sweep: the first time the hero is in view (not reduced
  // motion, not a held/active reveal already), pulse the spotlight across the
  // face once so visitors learn a photo hides under the ascii.
  function maybeAutoSweep() {
    if (reduced || sweepDone || sweeping || held) return;
    if (!built || !running || disposed) return;
    sweeping = true;
    sweepStart = performance.now();
  }

  // ---- sizing ----
  function fitAscii() {
    if (!built || !rows) return;
    const w = portrait.clientWidth;
    const h = portrait.clientHeight;
    if (!w || !h) return;
    // Cover fit: glyph grid fills the container (to the bottom edge); overflow is
    // clipped (.hv2-ascii has overflow:hidden). Grid aspect matches the box, so this
    // is an exact fill with negligible clip.
    const size = Math.max(w / (cols * ADV), h / rows);
    ascii.style.fontSize = size + 'px';
    ascii.style.lineHeight = size + 'px';
    const min = Math.min(w, h);
    // --rmax is the fully-open reveal radius; --radius (driven by openness in the
    // RAF loop) scales between 0 and --rmax. At rest radius 0 => no photo hole.
    rmax = Math.round(min * 0.32);
    portrait.style.setProperty('--rmax', rmax + 'px');
    applyRadius();
  }

  // ---- spotlight follow ----
  function applyRadius() {
    // radius = max radius * openness; openness 0 => 0px => no transparent hole.
    portrait.style.setProperty('--radius', (rmax * openness).toFixed(1) + 'px');
  }

  function paint() {
    ascii.style.setProperty('--mx', (cur.x * 100).toFixed(2) + '%');
    ascii.style.setProperty('--my', (cur.y * 100).toFixed(2) + '%');
    applyRadius();
  }

  function setTargetFromEvent(clientX, clientY) {
    const r = portrait.getBoundingClientRect();
    if (!r.width || !r.height) return;
    target.x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    target.y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  }

  function loopPointer() {
    if (sweeping) {
      // One-time teaching sweep: drive openness through a single in/out pulse over
      // the face center, ignoring pointer input, then settle back to pure ascii.
      const t = Math.min(1, (performance.now() - sweepStart) / SWEEP_MS);
      cur.x = 0.5; cur.y = 0.46; target.x = 0.5; target.y = 0.46;
      // smooth 0 -> 1 -> 0 pulse (sin over [0,pi])
      openness = Math.sin(t * Math.PI);
      if (t >= 1) {
        sweeping = false;
        sweepDone = true;
        openness = 0;
        openTarget = 0;
      }
      paint();
      rafId = requestAnimationFrame(loopPointer);
      return;
    }
    cur.x += (target.x - cur.x) * 0.14;
    cur.y += (target.y - cur.y) * 0.14;
    // ease openness toward its target (open while pointer is on portrait, or while
    // a tap/keyboard reveal is held)
    const want = (held || openTarget === 1) ? 1 : 0;
    openness += (want - openness) * 0.16;
    if (openness < 0.001) openness = 0;
    if (want === 1 && openness > 0.999) openness = 1;
    paint();
    rafId = requestAnimationFrame(loopPointer);
  }

  // Pointer events cover mouse, pen and touch.
  // Hover devices: openness rises while the pointer is on the portrait and the
  // spotlight follows the cursor (no latch).
  // Touch / no-hover devices: a tap latches `held` on/off (toggle); the reveal
  // persists until tapped again. touch-action:none on the portrait stops the tap
  // from being treated as a scroll gesture and cancelled.
  function openFromEvent(e) {
    if (!running) return;
    setTargetFromEvent(e.clientX, e.clientY);
    if (sweeping) { sweeping = false; sweepDone = true; }
    openTarget = 1;
    portrait.classList.add('active');
  }
  function onPointerMove(e) { if (noHover) return; openFromEvent(e); }
  function onPointerEnter(e) { if (noHover) return; openFromEvent(e); }
  function onPointerDown(e) {
    if (!running) return;
    if (noHover) { toggleHeld(e); return; } // touch: tap toggles
    openFromEvent(e);
  }
  function closeReveal() {
    if (!running) return;
    openTarget = 0;
    if (!held) portrait.classList.remove('active');
  }
  function onPointerLeave() { closeReveal(); }
  function onPointerCancel() { if (!noHover) closeReveal(); }

  // Latch/unlatch the persistent reveal (touch tap, Enter, Space).
  function toggleHeld(e) {
    if (!running) return;
    if (sweeping) { sweeping = false; sweepDone = true; }
    held = !held;
    if (e && typeof e.clientX === 'number') setTargetFromEvent(e.clientX, e.clientY);
    else { target.x = 0.5; target.y = 0.46; }
    openTarget = held ? 1 : 0;
    portrait.classList.toggle('active', held);
    // is-revealed drives the CSS opacity swap (photo/ascii) on touch devices,
    // where the radial-gradient mask can't be relied on to occlude the photo.
    portrait.classList.toggle('is-revealed', held);
    portrait.setAttribute('aria-pressed', held ? 'true' : 'false');
  }

  function onKeyToggle(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleHeld(null);
    }
  }

  // ---- typed command flourish ----
  function typeCommand() {
    return new Promise((resolve) => {
      if (reduced) { cmdText.textContent = COMMAND; resolve(); return; }
      let i = 0;
      const step = () => {
        if (!running || disposed) { typeTimer = 0; return; } // aborted mid-type
        cmdText.textContent = COMMAND.slice(0, i);
        i += 1;
        if (i <= COMMAND.length) {
          typeTimer = setTimeout(step, 40 + Math.random() * 38);
        } else {
          typeTimer = setTimeout(() => {
            typeTimer = 0;
            if (!running || disposed) return; // aborted during settle pause
            resolve();
          }, 260);
        }
      };
      step();
    });
  }

  // Type a string of HTML into el one visible character at a time. Tags are
  // emitted whole (so <span> wrappers stay intact) while their text content types
  // through, giving a terminal / streamed-output feel.
  function typeHTML(el, html) {
    return new Promise((resolve) => {
      let i = 0; const n = html.length;
      const step = () => {
        if (!running || disposed) { el.innerHTML = html; resolve(); return; }
        if (html[i] === '<') { const c = html.indexOf('>', i); i = (c === -1) ? n : c + 1; }
        else { i += 1; }
        el.innerHTML = html.slice(0, i);
        if (i < n) { typeTimer = setTimeout(step, 4 + Math.random() * 8); }
        else { el.innerHTML = html; resolve(); }
      };
      step();
    });
  }
  function pause(ms) { return new Promise((r) => { typeTimer = setTimeout(r, ms); }); }

  // Stream the copy lines (eyebrow -> title -> tagline) as terminal output after
  // the command runs, then fade the CTA in. Portrait fades via the is-on class.
  function revealLines() {
    caret.style.display = 'none';
    if (reduced) { out.classList.add('is-on'); return Promise.resolve(); }
    requestAnimationFrame(() => out.classList.add('is-on'));
    let chain = Promise.resolve();
    typeTargets.forEach((t) => {
      chain = chain
        .then(() => (running && !disposed) ? typeHTML(t.el, t.html) : null)
        .then(() => (running && !disposed) ? pause(150) : null);
    });
    chain = chain.then(() => {
      if (ctaEl && running && !disposed) { ctaEl.style.transition = 'opacity .45s ease'; ctaEl.style.opacity = '1'; }
    });
    return chain;
  }

  // Snap copy to its final state. Line ~149 clears the eyebrow/title/tagline so
  // they can stream in, but the only restore path (revealLines) runs once from a
  // bootStarted-guarded boot(); if the section is stopped or disposed before/while
  // typing, untyped lines stay empty and re-entry never re-reveals. Calling this on
  // every teardown guarantees the headline + CTA can never stay blank for the
  // session. Idempotent; a no-op under reduced motion (copy was never cleared).
  function ensureCopyShown() {
    if (reduced) return;
    caret.style.display = 'none';
    out.classList.add('is-on');
    // The command-prompt flourish is streamed once by typeCommand(); restore it too
    // so an interrupted boot can't leave the prompt blank or truncated (same bug class).
    if (cmdText.textContent !== COMMAND) cmdText.textContent = COMMAND;
    typeTargets.forEach((t) => {
      if (t.el.innerHTML === t.html) return; // already fully shown
      t.el.replaceChildren(...t.nodes.map((n) => n.cloneNode(true)));
    });
    if (ctaEl) { ctaEl.style.transition = 'none'; ctaEl.style.opacity = '1'; }
  }

  // ---- RAF lifecycle (start/stop) ----
  function beginMotion() {
    if (reduced) {
      // static PURE ASCII frame: openness stays 0 so --radius is 0 => no hole.
      cur.x = 0.5; cur.y = 0.5; target.x = 0.5; target.y = 0.5;
      openness = 0; openTarget = 0;
      paint();
      return;
    }
    if (rafId) return; // already looping
    // Single easing loop drives both spotlight follow and openness for mouse,
    // pen and touch alike. No auto-roam, no auto-reveal at rest.
    rafId = requestAnimationFrame(loopPointer);
  }

  function endMotion() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  // Pointer listeners drive the reveal for mouse, pen and touch. Under reduced
  // motion there is no reveal, so none are attached. pointerdown/up/cancel make
  // touch reveal only while a finger is on the portrait (no auto-reveal).
  if (!reduced) {
    portrait.addEventListener('pointermove', onPointerMove);
    portrait.addEventListener('pointerenter', onPointerEnter);
    portrait.addEventListener('pointerleave', onPointerLeave);
    portrait.addEventListener('pointerdown', onPointerDown);
    portrait.addEventListener('pointercancel', onPointerCancel);
    portrait.addEventListener('keydown', onKeyToggle);
    portrait.setAttribute('aria-pressed', 'false');
  }

  // ResizeObserver keeps ascii sized to mount/portrait, and re-samples the glyphs
  // when the responsive column count changes across a width breakpoint.
  const ro = new ResizeObserver(() => {
    if (!disposed && built && pickCols() !== cols) {
      buildPortrait();
    } else {
      fitAscii();
    }
  });
  ro.observe(portrait);
  ro.observe(mount);

  // build content once
  let bootStarted = false;
  function boot() {
    if (bootStarted) return;
    bootStarted = true;
    typeCommand().then(() => {
      if (!running || disposed) return; // boot chain aborted by stop()/dispose
      buildPortrait();
      paint();
      requestAnimationFrame(() => { if (!disposed) fitAscii(); });
      return revealLines();
    }).then(() => {
      if (!running || disposed) return;
      // Kick the one-time discoverability sweep once the lines have streamed in.
      setTimeout(maybeAutoSweep, 360);
    });
  }

  // Headshot load is decoupled from the boot gate: rebuild the (idempotent)
  // portrait whenever the bitmap is ready, even if that happens before boot()
  // runs (e.g. a cached image firing 'load' early). Silhouette stays the
  // guaranteed non-blank fallback.
  function onPhotoReady() {
    if (disposed) return;
    buildPortrait();
  }
  photo.addEventListener('load', onPhotoReady);
  photo.addEventListener('error', () => { if (!disposed) buildSilhouette(); });
  photo.src = PORTRAIT_SRC;
  if (typeof photo.decode === 'function') {
    photo.decode().then(onPhotoReady).catch(() => {});
  } else if (photo.complete && photo.naturalWidth) {
    onPhotoReady();
  }

  return {
    start() {
      if (running) return;
      running = true;
      boot();
      if (reduced) {
        beginMotion(); // static pure-ascii frame only
        return;
      }
      beginMotion();
    },
    stop() {
      if (!running) return;
      running = false;
      endMotion();
      // Cancel any pending typing/boot timer so the boot .then() cannot run
      // buildPortrait/revealLines after the section is logically stopped.
      if (typeTimer) { clearTimeout(typeTimer); typeTimer = 0; }
      // Guarantee the copy is fully shown even if we stopped mid-reveal: boot is
      // bootStarted-guarded, so a re-entry would otherwise leave the lines blank.
      ensureCopyShown();
      // Reset to a closed, centered frame so a later re-entry starts as pure ascii.
      target.x = 0.5; target.y = 0.5;
      openness = 0; openTarget = 0;
      held = false; sweeping = false;
      applyRadius();
      portrait.classList.remove('active');
      portrait.classList.remove('is-revealed');
      portrait.setAttribute('aria-pressed', 'false');
    },
    dispose() {
      disposed = true;
      running = false;
      endMotion();
      if (typeTimer) { clearTimeout(typeTimer); typeTimer = 0; }
      // Snap copy to full before teardown so a bfcache restore can't show a blank
      // headline (the DOM is preserved as-is across pagehide).
      ensureCopyShown();
      ro.disconnect();
      if (!reduced) {
        portrait.removeEventListener('pointermove', onPointerMove);
        portrait.removeEventListener('pointerenter', onPointerEnter);
        portrait.removeEventListener('pointerleave', onPointerLeave);
        portrait.removeEventListener('pointerdown', onPointerDown);
        portrait.removeEventListener('pointercancel', onPointerCancel);
        portrait.removeEventListener('keydown', onKeyToggle);
      }
    },
  };
}
