/**
 * Render the documentation into a static page.
 *
 * The landing has no build step and should keep it that way, so the
 * Markdown-to-HTML pass happens here, once, and the result is committed.
 * Nothing has to run for a reader to see the docs — which is also what makes
 * the site deployable to any static host.
 *
 *   npm run docs:build
 *
 * Source of truth is `apps/landing/content/*.md`, one file per section, in the
 * order listed below. Editing the Markdown and re-running is the whole loop.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(here, '../apps/landing/content');
const OUTPUT = path.resolve(here, '../apps/landing/docs.html');

/** Order is the reading order and the order of the sidebar. */
const SECTIONS = [
  { slug: 'what-it-is', title: 'What MailProof is' },
  { slug: 'what-is-an-sdk', title: 'What an SDK is' },
  { slug: 'quickstart', title: 'Quickstart' },
  { slug: 'api-reference', title: 'API reference' },
  { slug: 'security', title: 'Security model' },
] as const;

const REPO = 'https://github.com/NachoEstevo/mailproof';

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Make text safe to sit inside a `<script>` without changing it.
 *
 * HTML-escaping would be wrong here: a script element's content is raw text
 * and the browser does not decode entities in it, so `&lt;` would survive all
 * the way to the clipboard and the copied Markdown would be corrupt. The only
 * sequence that can end the element early is `</`, so that is the only one
 * that needs neutralising — and the backslash is invisible to a Markdown
 * reader in the one place it can appear.
 */
function inertInScript(text: string): string {
  return text.replace(/<\//g, '<\\/');
}

/**
 * Drop the H2 a section opens with.
 *
 * The page supplies its own heading, anchored for the sidebar. Leaving the
 * author's would put two of them next to each other, and only one would be a
 * link target.
 */
function withoutLeadingHeading(markdown: string): string {
  return markdown.replace(/^\s*##\s+.*\n/, '');
}

function render(): string {
  const rendered = SECTIONS.map((section) => {
    const markdown = readFileSync(path.join(CONTENT, `${section.slug}.md`), 'utf8');
    return {
      ...section,
      html: marked.parse(withoutLeadingHeading(markdown), { async: false, gfm: true }),
    };
  });

  const rawMarkdown = rendered
    .map((s) => `# ${s.title}\n\n${readFileSync(path.join(CONTENT, `${s.slug}.md`), 'utf8').replace(/^\s*##\s+.*\n/, '').trim()}`)
    .join('\n\n---\n\n');

  const toc = rendered
    .map((s) => `          <a href="#${s.slug}">${escape(s.title)}</a>`)
    .join('\n');

  const body = rendered
    .map(
      (s) => `        <section id="${s.slug}">
          <h2>${escape(s.title)}</h2>
${s.html
  .trim()
  .split('\n')
  .map((line) => `          ${line}`)
  .join('\n')}
        </section>`,
    )
    .join('\n\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Documentation — MailProof</title>
    <meta
      name="description"
      content="How to verify an email domain, once per person, without learning the address."
    />
    <meta name="theme-color" content="#faf1c5" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="styles.css" />
  </head>

  <body>
    <header class="bar on-paper">
      <nav>
        <a href="index.html">Home</a>
        <a href="#quickstart">Quickstart</a>
        <a href="#api-reference">API</a>
        <a href="#security">Security</a>
      </nav>
      <div class="wordmark"><a href="index.html" style="text-decoration: none">MailProof</a></div>
    </header>

    <div class="docs-layout">
      <aside class="toc">
        <strong>Documentation</strong>
${toc}
        <strong style="margin-top: 26px">Repository</strong>
        <a href="${REPO}">Source</a>
        <a href="${REPO}/blob/main/docs/DECISIONS.md">Decisions</a>
        <a href="${REPO}/blob/main/docs/KNOWN_LIMITATIONS.md">Known limitations</a>
      </aside>

      <main class="doc">
        <div class="doc-head">
          <p>MailProof · documentation</p>
          <button class="copy-all" id="copy-all" type="button">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.6" stroke="currentColor" stroke-width="1.5"/>
              <path d="M10.8 5.2V3.9c0-.8-.6-1.4-1.4-1.4H3.9c-.8 0-1.4.6-1.4 1.4v5.5c0 .8.6 1.4 1.4 1.4h1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span>Copy all docs</span>
          </button>
        </div>
${body}
      </main>
    </div>

    <!--
      The Markdown source, verbatim, for the copy button. In a script tag so it
      is inert: the browser will not parse it, and it survives being opened
      from a file:// URL where a fetch would not.
    -->
    <script type="text/markdown" id="docs-source">${inertInScript(rawMarkdown)}</script>

    <footer>
      <div class="page row">
        <div>
          <strong style="font-family: var(--serif); font-size: 19px">MailProof</strong>
          <p style="margin: 6px 0 0">Built on Midnight. Apache&nbsp;2.0.</p>
        </div>
        <div>
          <a href="index.html">Home</a> ·
          <a href="${REPO}">Repository</a>
        </div>
      </div>
    </footer>

    <script>
      // Highlight the section being read. IntersectionObserver rather than a
      // scroll handler, so it costs nothing while scrolling.
      // Copying the whole thing as Markdown is how people read documentation
      // now — into an editor, into a model, into a ticket.
      const copyButton = document.getElementById('copy-all');
      const label = copyButton.querySelector('span');
      copyButton.addEventListener('click', async () => {
        const source = document.getElementById('docs-source').textContent;
        try {
          await navigator.clipboard.writeText(source);
        } catch {
          // Clipboard access is refused on insecure origins and in some
          // browsers without a gesture it recognises; selecting the text is
          // worse than copying it but much better than nothing happening.
          const area = document.createElement('textarea');
          area.value = source;
          document.body.append(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        }
        // Four backslashes: two are eaten writing this file, two more by the
        // template literal that emits it. Written with one, the browser gets
        // /s+/ and counts the letter s.
        const words = source.trim().split(/\\s+/).length;
        label.textContent = \`Copied \${words.toLocaleString()} words\`;
        copyButton.classList.add('done');
        setTimeout(() => {
          label.textContent = 'Copy all docs';
          copyButton.classList.remove('done');
        }, 2600);
      });

      const links = new Map(
        [...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.hash.slice(1), a]),
      );
      const visible = new Set();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target.id);
            else visible.delete(entry.target.id);
          }
          // Only the topmost visible section is marked, or every section on a
          // short page lights up at once and the sidebar stops meaning anything.
          const current = [...links.keys()].find((id) => visible.has(id));
          for (const [id, link] of links) link.classList.toggle('active', id === current);
        },
        { rootMargin: '-96px 0px -68% 0px' },
      );
      for (const id of links.keys()) {
        const section = document.getElementById(id);
        if (section) observer.observe(section);
      }
    </script>
  </body>
</html>
`;
}

writeFileSync(OUTPUT, render());
console.log(`wrote ${path.relative(process.cwd(), OUTPUT)} from ${SECTIONS.length} sections`);
