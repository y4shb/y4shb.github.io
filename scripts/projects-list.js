// projects-list.js
// Populates the tier-1 project cards from /projects/_index.json.
// Each card is a clickable <a.proj-card-link> wrapping an <article.proj-card>,
// preserving the existing visual rhythm and the data-viz mounts so the
// IntersectionObserver in main.js can boot the WebGL scenes.

const INDEX_URL = '/projects/_index.json';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCardHtml(item) {
  const slug = escapeHtml(item.slug);
  const href = `/project.html?slug=${slug}`;
  const kicker = escapeHtml(item.kicker || '');
  const title = escapeHtml(item.title || '');
  const desc = escapeHtml(item.summary || item.description || '');
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const tagsHtml = tags
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join('');

  const viz = item.viz
    ? `<div class="proj-card-viz" data-viz="${escapeHtml(item.viz)}"></div>`
    : `<div class="proj-card-viz proj-card-viz--static" aria-hidden="true"></div>`;

  const descBlock = desc ? `<p class="proj-desc">${desc}</p>` : '';
  const tagsBlock = tagsHtml ? `<ul class="proj-tags">${tagsHtml}</ul>` : '';

  return (
    `<a class="proj-card-link" href="${href}">` +
      `<article class="proj-card reveal">` +
        viz +
        `<div class="proj-card-body">` +
          (kicker ? `<p class="proj-kicker">${kicker}</p>` : '') +
          `<h3 class="proj-title">${title}</h3>` +
          descBlock +
          tagsBlock +
        `</div>` +
      `</article>` +
    `</a>`
  );
}

export default async function mountProjects(rootSelector = '.proj-tier1') {
  const root = document.querySelector(rootSelector);
  if (!root) return;

  let data;
  try {
    const res = await fetch(INDEX_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn('[projects-list] failed to load index:', err);
    return;
  }

  const items = Array.isArray(data && data.items) ? data.items : [];
  const enabled = items.filter((it) => it && it.enabled !== false && it.slug && it.title);
  if (enabled.length === 0) return;

  const html = enabled.map(buildCardHtml).join('');
  const range = document.createRange();
  range.selectNodeContents(root);
  const fragment = range.createContextualFragment(html);

  // Clear the static fallback cards, then attach the fresh ones.
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(fragment);

  // Hand the freshly mounted data-viz nodes + reveal targets back to main.js
  // so the IntersectionObservers (viz scene boot + scroll-reveal) pick them up.
  const vizNodes = Array.from(root.querySelectorAll('[data-viz]'));
  const revealNodes = Array.from(root.querySelectorAll('.reveal'));
  document.dispatchEvent(new CustomEvent('projects:mounted', {
    detail: { viz: vizNodes, reveal: revealNodes },
  }));
}

export { mountProjects };

// Auto-mount when the script tag is loaded directly on the home page.
// No-ops on pages without .proj-tier1.
mountProjects();
