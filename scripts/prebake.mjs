// prebake.mjs - prerender /article/<slug>.html, /project/<slug>.html shells,
// sitemap.xml, llms.txt, llms-full.txt. Meta block mirrors article.html JS DOM.
// Tables wrapped in .table-wrap for per-table scroll. JSON-LD references the
// Person/WebSite graph by @id (those live in index.html). ASCII hyphen only.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MERMAID_VERSION = "11.15.0"; // covers CVE-2025-54881, CVE-2026-41150
const BASE_URL = "https://y4shbhardwaj.com";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG_RE = /^[a-z0-9-]+$/;

const PATHS = {
  articlesDir: path.join(ROOT, "articles"),
  projectsDir: path.join(ROOT, "projects"),
  articleOut: path.join(ROOT, "article"),
  projectOut: path.join(ROOT, "project"),
  sitemap: path.join(ROOT, "sitemap.xml"),
  llms: path.join(ROOT, "llms.txt"),
  llmsFull: path.join(ROOT, "llms-full.txt"),
};

// -----------------------------------------------------------------------------
// Escape helpers
// -----------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  // Same set is safe in attributes; kept as a distinct name for clarity.
  return escapeHtml(s);
}

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`~\[\]()!\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// -----------------------------------------------------------------------------
// Date formatting
// -----------------------------------------------------------------------------
// Parse "YYYY-MM-DD" via regex then build the Date with the 3-arg constructor
// so we get a *local* date and avoid the UTC-midnight timezone shift bug.

function formatDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// -----------------------------------------------------------------------------
// Marked configuration
// -----------------------------------------------------------------------------
// We override:
//   - table: wrap in <div class="table-wrap"> so each table gets its own
//     horizontal scroll context (fixes mobile overflow on article 01).
//   - code:  emit a <pre class="mermaid"> for mermaid blocks (client renders),
//            otherwise emit a standard <pre><code class="hljs language-..."> so
//            highlight.js picks it up.

function configureMarked() {
  const renderer = new marked.Renderer();

  renderer.table = function (header, body) {
    let out = "<table>\n";
    if (header) out += "<thead>\n" + header + "</thead>\n";
    if (body) out += "<tbody>\n" + body + "</tbody>\n";
    out += "</table>\n";
    return '<div class="table-wrap">' + out + "</div>\n";
  };

  renderer.code = function (code, infostring) {
    const lang = (infostring || "").trim().split(/\s+/)[0] || "";
    if (lang === "mermaid") {
      return '<pre class="mermaid">' + escapeHtml(code) + "</pre>\n";
    }
    const cls = lang ? ' class="hljs language-' + escapeAttr(lang) + '"' : "";
    return "<pre><code" + cls + ">" + escapeHtml(code) + "</code></pre>\n";
  };

  marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: true,
    mangle: false,
  });
  marked.use({ renderer });
  return renderer;
}

// -----------------------------------------------------------------------------
// JSON-LD builders
// -----------------------------------------------------------------------------

function articleLd({ item, title, desc, canonical }) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    datePublished: item.date,
    author: { "@id": BASE_URL + "/#person" },
    publisher: { "@id": BASE_URL + "/#person" },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    url: canonical,
    description: desc,
    keywords: Array.isArray(item.tags) ? item.tags.join(", ") : "",
  };
}

function projectLd({ item, title, desc, canonical }) {
  return {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    headline: title,
    author: { "@id": BASE_URL + "/#person" },
    publisher: { "@id": BASE_URL + "/#person" },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    url: canonical,
    description: desc,
    keywords: Array.isArray(item.tags) ? item.tags.join(", ") : "",
  };
}

// -----------------------------------------------------------------------------
// Meta block (mirrors article.html JS-rendered DOM exactly)
// -----------------------------------------------------------------------------

function tagsHtml(tags) {
  if (!Array.isArray(tags) || !tags.length) return "";
  return tags
    .slice(0, 8)
    .map((t) => '<span class="chip">' + escapeHtml(t) + "</span>")
    .join("");
}

function articleMetaBlock(item) {
  const readMin = Math.max(1, item.readMin || 10);
  const dateStr = formatDate(item.date);
  return (
    '<div class="blog-meta" id="meta">' +
    '<div class="meta-top">' +
    '<span class="meta-pill meta-pill--essay">essay</span>' +
    '<div class="meta-tags" aria-label="Tags">' +
    tagsHtml(item.tags) +
    "</div>" +
    "</div>" +
    '<div class="meta-bottom">' +
    '<span class="meta-read">' + readMin + " min read</span>" +
    '<span class="meta-dot" aria-hidden="true">&middot;</span>' +
    '<span class="meta-date">' + escapeHtml(dateStr) + "</span>" +
    "</div>" +
    "</div>"
  );
}

function projectMetaBlock(item, words) {
  const readMin = Math.max(1, item.readMin || Math.round(words / 225));
  return (
    '<div class="blog-meta" id="meta">' +
    '<div class="meta-top">' +
    '<span class="meta-pill meta-pill--project">project</span>' +
    '<div class="meta-tags" aria-label="Tags">' +
    tagsHtml(item.tags) +
    "</div>" +
    "</div>" +
    '<div class="meta-bottom">' +
    '<span class="meta-read">' + readMin + " min read</span>" +
    '<span class="meta-dot" aria-hidden="true">&middot;</span>' +
    '<span class="meta-kicker">' + escapeHtml(item.kicker || "") + "</span>" +
    "</div>" +
    "</div>"
  );
}

// -----------------------------------------------------------------------------
// HTML shell
// -----------------------------------------------------------------------------

function headHtml({ title, desc, canonical, ogType, ldJson }) {
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" + escapeHtml(title) + "</title>\n" +
    '<meta name="description" content="' + escapeAttr(desc) + '">\n' +
    '<meta name="author" content="Yash Bhardwaj">\n' +
    '<link rel="canonical" href="' + canonical + '">\n' +
    '<meta property="og:type" content="' + ogType + '">\n' +
    '<meta property="og:title" content="' + escapeAttr(title) + '">\n' +
    '<meta property="og:description" content="' + escapeAttr(desc) + '">\n' +
    '<meta property="og:url" content="' + canonical + '">\n' +
    '<meta property="og:image" content="' + BASE_URL + '/og.png">\n' +
    '<meta property="og:image:width" content="1200">\n' +
    '<meta property="og:image:height" content="630">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="twitter:title" content="' + escapeAttr(title) + '">\n' +
    '<meta name="twitter:description" content="' + escapeAttr(desc) + '">\n' +
    '<meta name="twitter:image" content="' + BASE_URL + '/og.png">\n' +
    '<meta name="theme-color" content="#0a0a0a">\n' +
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n' +
    '<link rel="apple-touch-icon" href="/favicon.svg">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">\n' +
    '<link rel="stylesheet" href="/styles/tokens.css">\n' +
    '<link rel="stylesheet" href="/styles/global.css">\n' +
    '<link rel="stylesheet" href="/styles/content.css">\n' +
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">\n' +
    '<script type="application/ld+json">' + JSON.stringify(ldJson) + "</script>\n" +
    "</head>\n"
  );
}

function bodyHtml({ metaBlock, bodyHtml }) {
  return (
    '<body class="reader-body">\n' +
    '<div class="progress" id="progress"></div>\n' +
    '<header class="nav scrolled" id="nav">' +
    '<a class="nav-brand" href="/">Yash Bhardwaj<span class="dot">.</span></a>' +
    '<nav class="nav-links" aria-label="Primary"><a href="/#projects">portfolio &#x2197;</a></nav>' +
    "</header>\n" +
    '<main id="top"><article class="blog blog-wrap" id="article">\n' +
    metaBlock +
    '<div id="content" data-prebaked="1">' + bodyHtml + "</div>\n" +
    "</article>" +
    '<footer class="blog-foot">' +
    '<a href="/#projects">&#x2190; back to portfolio</a>' +
    '<a href="#top">top &#x2191;</a>' +
    "</footer></main>\n" +
    '<script defer src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>\n' +
    '<script type="module">\n' +
    "import { hydratePrebaked } from '/scripts/content.js';\n" +
    "hydratePrebaked();\n" +
    "if (document.querySelector('#content .mermaid')) {\n" +
    "  const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@" + MERMAID_VERSION + "/dist/mermaid.esm.min.mjs');\n" +
    "  mermaid.initialize({ startOnLoad:false, theme:'dark', themeVariables:{ fontFamily:\"'Geist Mono', ui-monospace, Menlo, monospace\", darkMode:true, background:'#0d0d0f', primaryColor:'#1a1a1d', primaryTextColor:'#ededed', primaryBorderColor:'#2a2a30', lineColor:'#8a8f98', secondaryColor:'#141414', tertiaryColor:'#0a0a0a', noteBkgColor:'#141414', noteTextColor:'#8a8f98', noteBorderColor:'#2a2a30', actorBkg:'#141414', actorBorder:'#2a2a30', actorTextColor:'#ededed', signalColor:'#8a8f98', signalTextColor:'#ededed' }});\n" +
    "  try { await mermaid.run({ querySelector: '#content .mermaid' }); } catch(e) { console.warn('mermaid', e); }\n" +
    "}\n" +
    "</script>\n" +
    "</body></html>\n"
  );
}

function buildArticleShell(item, renderedBody) {
  const canonical = BASE_URL + "/article/" + item.slug + ".html";
  const title = item.title + " - Yash Bhardwaj";
  const desc = (item.subtitle || item.summary || "").slice(0, 200);
  const ldJson = articleLd({ item, title: item.title, desc, canonical });
  const meta = articleMetaBlock(item);
  return (
    headHtml({ title, desc, canonical, ogType: "article", ldJson }) +
    bodyHtml({ metaBlock: meta, bodyHtml: renderedBody })
  );
}

function buildProjectShell(item, renderedBody, words) {
  const canonical = BASE_URL + "/project/" + item.slug + ".html";
  const title = item.title + " - Yash Bhardwaj";
  const desc = (item.subtitle || item.summary || "").slice(0, 200);
  const ldJson = projectLd({ item, title: item.title, desc, canonical });
  const meta = projectMetaBlock(item, words);
  return (
    headHtml({ title, desc, canonical, ogType: "website", ldJson }) +
    bodyHtml({ metaBlock: meta, bodyHtml: renderedBody })
  );
}

// -----------------------------------------------------------------------------
// llms.txt and llms-full.txt
// -----------------------------------------------------------------------------

function buildLlmsTxt(articles, projects) {
  const lines = [];
  lines.push("# Yash Bhardwaj");
  lines.push("");
  lines.push("> Senior Software Engineer at AMD (Bengaluru). Backend systems, developer tools, GPU firmware CI, LLM log triage. Maker of DCAuto, Sherlog Holmes, and the Qualcomm Software Center macOS universal build.");
  lines.push("");
  lines.push("The canonical homepage is " + BASE_URL + ". Each article and project has a raw Markdown source and a prerendered HTML version. Markdown is recommended for ingestion, HTML for citation.");
  lines.push("");
  lines.push("## About");
  lines.push("- [Home](" + BASE_URL + "/): Bio, experience, projects, articles, and contact.");
  lines.push("- [Resume PDF](" + BASE_URL + "/YashBhardwaj.pdf): Resume.");
  lines.push("- [GitHub](https://github.com/y4shb): Source repositories.");
  lines.push("- [LinkedIn](https://www.linkedin.com/in/yash-bhardwaj-x): Professional profile.");
  lines.push("");
  lines.push("## Projects");
  for (const p of projects) {
    const desc = (p.item.summary || "").replace(/\s+/g, " ").trim();
    lines.push("- [" + p.item.title + "](" + BASE_URL + "/project/" + p.item.slug + ".html): " + desc);
  }
  lines.push("");
  lines.push("## Articles");
  // Reverse chronological: newest first.
  const sorted = [...articles].sort((a, b) => (b.item.date || "").localeCompare(a.item.date || ""));
  for (const a of sorted) {
    const desc = (a.item.subtitle || "").replace(/\s+/g, " ").trim();
    lines.push("- [" + a.item.title + "](" + BASE_URL + "/article/" + a.item.slug + ".html): " + desc);
  }
  lines.push("");
  lines.push("## Optional");
  lines.push("- [llms-full.txt](" + BASE_URL + "/llms-full.txt): Every article and project body in full.");
  lines.push("- [Articles index JSON](" + BASE_URL + "/articles/_index.json): Machine-readable manifest.");
  lines.push("- [Projects index JSON](" + BASE_URL + "/projects/_index.json): Machine-readable manifest.");
  return lines.join("\n") + "\n";
}

function buildLlmsFullTxt(articles, projects) {
  const lines = [];
  lines.push("# Yash Bhardwaj");
  lines.push("> Senior Software Engineer at AMD (Bengaluru). Backend systems, developer tools, GPU firmware CI, LLM log triage. Maker of DCAuto, Sherlog Holmes, and the Qualcomm Software Center macOS universal build.");
  lines.push("");
  lines.push("This file contains every article and project body in full, suitable for one-shot ingestion by an LLM agent. Canonical URLs are at " + BASE_URL + ".");
  lines.push("");
  lines.push("## Index");
  lines.push("- [Home](" + BASE_URL + "/)");
  for (const p of projects) {
    const desc = (p.item.summary || "").replace(/\s+/g, " ").trim();
    lines.push("- [" + p.item.title + "](" + BASE_URL + "/project/" + p.item.slug + ".html): " + desc);
  }
  const sortedArticles = [...articles].sort((a, b) => (b.item.date || "").localeCompare(a.item.date || ""));
  for (const a of sortedArticles) {
    const desc = (a.item.subtitle || "").replace(/\s+/g, " ").trim();
    lines.push("- [" + a.item.title + "](" + BASE_URL + "/article/" + a.item.slug + ".html): " + desc);
  }
  lines.push("");
  lines.push("## Projects (full text)");
  for (const p of projects) {
    lines.push("### " + p.item.title);
    lines.push("Source: " + BASE_URL + "/project/" + p.item.slug + ".html");
    lines.push("Kicker: " + (p.item.kicker || ""));
    lines.push("Tags: " + (Array.isArray(p.item.tags) ? p.item.tags.join(", ") : ""));
    lines.push("");
    lines.push(p.md.trim());
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  lines.push("## Articles (full text)");
  // Chronological in full text section: oldest first so the body reads as a series.
  const articlesChrono = [...articles].sort((a, b) => (a.item.date || "").localeCompare(b.item.date || ""));
  for (const a of articlesChrono) {
    lines.push("### " + a.item.title);
    lines.push("Source: " + BASE_URL + "/article/" + a.item.slug + ".html");
    lines.push("Published: " + (a.item.date || ""));
    lines.push("Tags: " + (Array.isArray(a.item.tags) ? a.item.tags.join(", ") : ""));
    lines.push("Read time: " + (a.item.readMin || 10) + " min");
    lines.push("");
    lines.push(a.md.trim());
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// sitemap.xml
// -----------------------------------------------------------------------------

function buildSitemap(articles, projects) {
  // Compute per-entry lastmods first so we can derive the home lastmod as the
  // max of all children (home updates whenever its newest child does). ISO
  // YYYY-MM-DD sorts correctly via string comparison.
  const articleEntries = articles.map((a) => ({
    slug: a.item.slug,
    lastmod: a.item.date || a.mtime,
  }));
  const projectEntries = projects.map((p) => ({
    slug: p.item.slug,
    lastmod: p.item.date || p.mtime,
  }));
  const allLastmods = [
    ...articleEntries.map((e) => e.lastmod),
    ...projectEntries.map((e) => e.lastmod),
  ].filter(Boolean);
  const homeLastmod = allLastmods.length
    ? allLastmods.reduce((max, d) => (d > max ? d : max))
    : "";

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  lines.push(
    "  <url><loc>" + BASE_URL + "/</loc>" +
    (homeLastmod ? "<lastmod>" + homeLastmod + "</lastmod>" : "") +
    "<changefreq>weekly</changefreq><priority>1.0</priority></url>"
  );
  for (const e of articleEntries) {
    lines.push(
      "  <url><loc>" + BASE_URL + "/article/" + e.slug + ".html</loc>" +
      "<lastmod>" + e.lastmod + "</lastmod>" +
      "<changefreq>monthly</changefreq>" +
      "<priority>0.6</priority></url>"
    );
  }
  for (const e of projectEntries) {
    lines.push(
      "  <url><loc>" + BASE_URL + "/project/" + e.slug + ".html</loc>" +
      "<lastmod>" + e.lastmod + "</lastmod>" +
      "<changefreq>monthly</changefreq>" +
      "<priority>0.8</priority></url>"
    );
  }
  lines.push("</urlset>");
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// Pipeline
// -----------------------------------------------------------------------------

async function loadIndex(dir) {
  const j = JSON.parse(await readFile(path.join(dir, "_index.json"), "utf8"));
  return (j.items || []).filter((i) => i && i.enabled !== false);
}

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

async function bakeArticles() {
  const items = await loadIndex(PATHS.articlesDir);
  await mkdir(PATHS.articleOut, { recursive: true });
  const out = [];
  for (const item of items) {
    if (!SLUG_RE.test(item.slug)) throw new Error("bad slug: " + item.slug);
    const mdPath = path.join(PATHS.articlesDir, item.file);
    if (!existsSync(mdPath)) throw new Error("missing md: " + mdPath);
    const md = await readFile(mdPath, "utf8");
    const html = marked.parse(md);
    if (!/<h1[^>]*>[\s\S]*?<\/h1>/i.test(html)) {
      throw new Error("no H1 in " + item.file);
    }
    const shell = buildArticleShell(item, html);
    const outPath = path.join(PATHS.articleOut, item.slug + ".html");
    await writeFile(outPath, shell, "utf8");
    const st = await stat(mdPath);
    out.push({ item, md, mtime: st.mtime.toISOString().slice(0, 10) });
    console.log("baked article/" + item.slug + ".html");
  }
  return out;
}

async function bakeProjects() {
  const items = await loadIndex(PATHS.projectsDir);
  await mkdir(PATHS.projectOut, { recursive: true });
  const out = [];
  for (const item of items) {
    if (!SLUG_RE.test(item.slug)) throw new Error("bad slug: " + item.slug);
    const mdPath = path.join(PATHS.projectsDir, item.file);
    if (!existsSync(mdPath)) throw new Error("missing md: " + mdPath);
    const md = await readFile(mdPath, "utf8");
    const html = marked.parse(md);
    if (!/<h1[^>]*>[\s\S]*?<\/h1>/i.test(html)) {
      throw new Error("no H1 in " + item.file);
    }
    const words = stripMarkdown(md).split(/\s+/).filter(Boolean).length;
    const shell = buildProjectShell(item, html, words);
    const outPath = path.join(PATHS.projectOut, item.slug + ".html");
    await writeFile(outPath, shell, "utf8");
    const st = await stat(mdPath);
    out.push({ item, md, mtime: st.mtime.toISOString().slice(0, 10) });
    console.log("baked project/" + item.slug + ".html");
  }
  return out;
}

async function main() {
  configureMarked();
  const articles = await bakeArticles();
  const projects = await bakeProjects();
  await writeFile(PATHS.sitemap, buildSitemap(articles, projects), "utf8");
  await writeFile(PATHS.llms, buildLlmsTxt(articles, projects), "utf8");
  await writeFile(PATHS.llmsFull, buildLlmsFullTxt(articles, projects), "utf8");
  console.log("wrote sitemap.xml + llms.txt + llms-full.txt");
  console.log("done (" + todayIso() + ")");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
