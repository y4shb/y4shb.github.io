// Shared markdown renderer for /article.html and /project.html.
// Reads /{articles|projects}/_index.json, resolves the slug, fetches the .md,
// parses with marked@12 (mermaid fences -> div.mermaid; other fences -> hljs),
// inserts via Range.createContextualFragment (never .innerHTML), runs mermaid,
// wires the scroll progress bar, sets <title> from the H1, and fills the meta
// strip (reading time, word count, kicker for projects).
//
// kind: 'articles' or 'projects' (matches the directory name).

const VALID_KINDS = new Set(['articles', 'projects']);
const SLUG_RE = /^[a-z0-9-]+$/;
const WPM = 225;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function insertHtml(node, html) {
  // Range + createContextualFragment keeps us off .innerHTML (security hook).
  const range = document.createRange();
  range.selectNode(node);
  node.appendChild(range.createContextualFragment(html));
}

function configureMarked() {
  if (typeof marked === 'undefined') return;
  const renderer = new marked.Renderer();
  renderer.code = function (code, lang) {
    if (lang === 'mermaid') {
      return '<div class="mermaid">' + escapeHtml(code) + '</div>';
    }
    const language = lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang) ? lang : 'plaintext';
    const out = (typeof hljs !== 'undefined')
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : escapeHtml(code);
    return '<pre><code class="hljs language-' + language + '">' + out + '</code></pre>';
  };
  renderer.table = function (header, body) {
    return '<div class="table-wrap"><table>\n<thead>\n' + header + '</thead>\n<tbody>\n' + body + '</tbody></table></div>\n';
  };
  marked.use({ renderer, gfm: true, breaks: false });
}

function wireProgress() {
  const bar = document.getElementById('progress');
  if (!bar) return;
  let pending = false;
  function tick() {
    pending = false;
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const pct = max > 0 ? (h.scrollTop / max) * 100 : 0;
    bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }
  function onScroll() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(tick);
  }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  tick();
}

function render404(reason) {
  const content = document.getElementById('content');
  if (content) {
    clear(content);
    const html =
      '<div class="reader-404">' +
        '<h1>not found</h1>' +
        '<p>' + escapeHtml(reason || 'this page does not exist') + '</p>' +
        '<a href="/#projects">Back home</a>' +
      '</div>';
    insertHtml(content, html);
  }
  document.title = 'not found - Yash Bhardwaj';
}

export async function renderContent({ kind, slug, mermaid } = {}) {
  const content = document.getElementById('content');
  if (!content) return;

  if (content.dataset.prebaked === '1') {
    // Page was prerendered. Just wire the progress bar and exit.
    wireProgress();
    return;
  }

  if (!VALID_KINDS.has(kind) || !slug || !SLUG_RE.test(slug)) {
    return render404('bad url');
  }

  const base = '/' + kind;
  let index, item, md;
  try {
    const idxRes = await fetch(base + '/_index.json', { cache: 'no-cache' });
    if (!idxRes.ok) throw new Error('index ' + idxRes.status);
    index = await idxRes.json();
  } catch (e) {
    console.warn('[content] index load failed', e);
    return render404('not found');
  }

  item = (index.items || []).find(it => it && it.slug === slug);
  if (!item || item.enabled === false) {
    return render404('not found');
  }

  try {
    const mdRes = await fetch(base + '/' + item.file, { cache: 'no-cache' });
    if (!mdRes.ok) throw new Error('md ' + mdRes.status);
    md = await mdRes.text();
  } catch (e) {
    console.warn('[content] markdown load failed', e);
    return render404('not found');
  }

  configureMarked();
  const html = (typeof marked !== 'undefined') ? marked.parse(md) : escapeHtml(md);
  clear(content);
  insertHtml(content, html);

  const h1 = content.querySelector('h1');
  document.title = (h1 ? h1.textContent.trim() : item.title) + ' - Yash Bhardwaj';

  // SEO: canonical + meta description so crawlers that DO execute JS get the right tags.
  // (Prebaked pages emit these statically; this is the JS-fallback path.)
  const canonicalHref = 'https://y4shbhardwaj.com/' + (kind === 'articles' ? 'article' : 'project') + '/' + slug + '.html';
  if (!document.querySelector('link[rel="canonical"]')) {
    const c = document.createElement('link'); c.rel = 'canonical'; c.href = canonicalHref; document.head.appendChild(c);
  }
  const descText = item.subtitle || item.summary || (content.textContent.trim().slice(0, 200));
  if (descText && !document.querySelector('meta[name="description"]')) {
    const d = document.createElement('meta'); d.name = 'description'; d.content = descText; document.head.appendChild(d);
  }

  // reading time only; word count is deliberately omitted from the UI
  const words = content.textContent.trim().split(/\s+/).filter(Boolean).length;
  const readMin = Math.max(1, item.readMin || Math.round(words / WPM));
  const rt = document.getElementById('reading-time');
  if (rt) rt.textContent = readMin + ' min read';

  // article meta: formatted date (Nov 12, 2025) - constructed from parts to
  // dodge timezone shift when parsing 'YYYY-MM-DD' as UTC midnight
  const dateEl = document.getElementById('meta-date');
  if (dateEl && item.date) {
    const m = String(item.date).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      dateEl.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } else {
      dateEl.textContent = String(item.date);
    }
  }

  // project meta: kicker slot
  if (kind === 'projects') {
    const ks = document.getElementById('kicker-slot');
    if (ks) ks.textContent = item.kicker || '';
  }

  // tag chips: small bordered mono pills, populated from index.json item.tags
  const tagMount = document.getElementById('meta-tags');
  if (tagMount && Array.isArray(item.tags) && item.tags.length) {
    tagMount.replaceChildren();
    for (const t of item.tags.slice(0, 8)) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = String(t);
      tagMount.appendChild(chip);
    }
  }

  // mermaid pass (only if any fences rendered)
  if (mermaid && content.querySelector('.mermaid')) {
    try {
      await mermaid.run({ querySelector: '#content .mermaid' });
    } catch (e) {
      console.warn('[content] mermaid run failed', e);
    }
  }

  wireProgress();
}

export default renderContent;

export function hydratePrebaked() {
  // Called from prebaked /article/<slug>.html and /project/<slug>.html. The body
  // is already painted with the rendered markdown; we only need to wire the
  // scroll progress bar. Title, meta, and canonical are already in the static head.
  const content = document.getElementById('content');
  if (!content) return;
  wireProgress();
}
