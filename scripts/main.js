// Orchestrator: nav state, scroll reveal, tab switching, and lazy per-section
// visual init. Each visual lives in scripts/sections/<name>.js and exports
// default init(mount, ctx) -> { start(), stop() }. Only the visible scene runs.

// Mark JS as live so reveal-hiding only applies when this module actually runs.
// If main.js never executes (file://, blocked modules), content stays fully visible.
document.documentElement.classList.add('js');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- nav: blur on scroll + active link ---- */
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 80);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---- mobile nav toggle ---- */
const navToggle = document.querySelector('.nav-toggle');
if (nav && navToggle) {
  const setMenu = open => {
    if (open) nav.setAttribute('data-menu-open', '');
    else nav.removeAttribute('data-menu-open');
    navToggle.setAttribute('aria-expanded', String(open));
  };
  navToggle.addEventListener('click', () => {
    setMenu(!nav.hasAttribute('data-menu-open'));
  });
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.addEventListener('click', () => setMenu(false));
  });
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && nav.hasAttribute('data-menu-open')) setMenu(false);
  });
}

const navLinks = [...document.querySelectorAll('.nav-links a[href^="#"]')];
const linkFor = id => navLinks.find(a => a.getAttribute('href') === '#' + id);
const navObserver = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    navLinks.forEach(a => a.classList.remove('active'));
    linkFor(e.target.id)?.classList.add('active');
  });
}, { rootMargin: '-45% 0px -50% 0px' });
['about', 'experience', 'projects'].forEach(id => {
  const el = document.getElementById(id);
  if (el) navObserver.observe(el);
});

/* ---- scroll reveal ---- */
const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealObserver.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

/* ---- experience tabs ---- */
document.querySelectorAll('[data-tabs]').forEach(group => {
  const tabs = [...group.querySelectorAll('.exp-tab')];
  const panels = [...group.querySelectorAll('.exp-panel')];
  const select = name => {
    tabs.forEach(t => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      // roving tabindex: the selected tab is the single tabstop for the group
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(p => {
      const on = p.dataset.panel === name;
      p.classList.toggle('is-active', on);
      p.hidden = !on;
    });
    // notify the experience visual which tab is active (die runs on AMD only)
    document.dispatchEvent(new CustomEvent('exp:tab', { detail: { name } }));
  };
  // initialize roving tabindex on load: selected tab = 0, others = -1
  tabs.forEach(t => { t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; });
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t.dataset.tab));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      next.focus(); select(next.dataset.tab);
    });
  });
});

/* ---- about: inline brand wordmarks cloned from the experience tabs ---- */
document.querySelectorAll('.brand[data-logo]').forEach(slot => {
  const name = slot.getAttribute('data-logo');
  const src = document.querySelector(`.exp-tab[data-tab="${name}"] .exp-tab-wordmark`);
  if (!src) return;
  const label = slot.textContent.trim();
  const svg = src.cloneNode(true);
  svg.removeAttribute('class');
  svg.classList.add('brand-logo', 'brand-logo--' + name);
  svg.setAttribute('aria-hidden', 'true');
  slot.textContent = '';
  slot.appendChild(svg);
  const vh = document.createElement('span');
  vh.className = 'vh';
  vh.textContent = label;
  slot.appendChild(vh);
});

/* ---- lazy visual modules ---- */
const ctx = { reducedMotion };
const mounts = document.querySelectorAll('[data-viz]');
const instances = new Map();

const vizObserver = new IntersectionObserver(async entries => {
  for (const e of entries) {
    const mount = e.target;
    const name = mount.dataset.viz;
    if (e.isIntersecting) {
      if (!instances.has(mount)) {
        instances.set(mount, 'loading');
        try {
          const mod = await import(`./sections/${name}.js`);
          const inst = (mod.default || mod.init)(mount, ctx) || {};
          instances.set(mount, inst);
          inst.start?.();
        } catch (err) {
          instances.set(mount, null);
          console.warn(`[viz] ${name} not available yet:`, err.message);
        }
      } else {
        const inst = instances.get(mount);
        if (inst && inst !== 'loading') inst.start?.();
      }
    } else {
      const inst = instances.get(mount);
      // stop() pauses the loop but intentionally retains the GL context so
      // re-entry is cheap (no module re-import). Full release happens on pagehide.
      if (inst && inst !== 'loading') inst.stop?.();
    }
  }
}, { rootMargin: '120px' });
mounts.forEach(m => vizObserver.observe(m));

// Release every WebGL context (experience, divider, proj-dcauto, proj-sherlog)
// at end of page lifecycle. Sections that define dispose() free their GL context;
// those that do not simply fall through. pagehide covers bfcache + unload.
addEventListener('pagehide', () => {
  instances.forEach(inst => { if (inst && inst !== 'loading') inst.dispose?.(); });
}, { once: true });
