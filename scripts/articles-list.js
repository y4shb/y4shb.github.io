// Home-page Articles list populator. Fetches /articles/_index.json,
// keeps enabled entries in the file's declared order, and renders each as a
// row link to /article.html?slug=<slug>. Safe to load on any page:
// no-ops when the mount element is absent.

const MOUNT_SELECTOR = '#articles-list';
const INDEX_URL = '/articles/_index.json';

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const isValidSlug = s => typeof s === 'string' && /^[a-z0-9-]+$/.test(s);

const rowHtml = item => {
  const slug = escapeHtml(item.slug);
  const href = `/article.html?slug=${slug}`;
  const title = escapeHtml(item.title || item.slug);
  const sub = item.subtitle ? `<p class="article-row-sub">${escapeHtml(item.subtitle)}</p>` : '';
  const date = item.date ? `<span class="article-row-date">${escapeHtml(item.date)}</span>` : '<span class="article-row-date"></span>';
  const tags = Array.isArray(item.tags) && item.tags.length
    ? `<span class="article-row-tags">${escapeHtml(item.tags.slice(0, 2).join(' / '))}</span>`
    : '<span class="article-row-tags"></span>';
  return `<li><a class="article-row" href="${href}">`
    + date
    + `<div class="article-row-main"><p class="article-row-title">${title}</p>${sub}</div>`
    + tags
    + `</a></li>`;
};

const fragmentFromHtml = html => {
  const range = document.createRange();
  return range.createContextualFragment(html);
};

const renderError = mount => {
  mount.replaceChildren();
  mount.appendChild(fragmentFromHtml('<li class="article-row-empty">Articles unavailable.</li>'));
};

const mountArticles = async (rootSelector = MOUNT_SELECTOR) => {
  const mount = document.querySelector(rootSelector);
  if (!mount) return;
  try {
    const res = await fetch(INDEX_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const visible = items
      .filter(it => it && it.enabled !== false && isValidSlug(it.slug) && it.file)
      // newest first; ISO YYYY-MM-DD compares correctly as a string
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    mount.replaceChildren();
    if (!visible.length) {
      mount.appendChild(fragmentFromHtml('<li class="article-row-empty">No articles yet.</li>'));
      return;
    }
    const html = visible.map(rowHtml).join('');
    mount.appendChild(fragmentFromHtml(html));
  } catch (err) {
    console.warn('[articles-list] failed to load:', err.message);
    renderError(mount);
  }
};

export default mountArticles;
export { mountArticles };

// Auto-mount when the script tag is loaded directly on the home page.
// No-ops on pages without #articles-list.
mountArticles();
