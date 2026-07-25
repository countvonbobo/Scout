(function installScoutReportView(global) {
  const KNOWN = new Set([
    'Scan runs', 'Headline', 'Action today', 'One check from unlocking',
    'Follow-ups due', 'Changes since last scan', 'Discarded', 'Verdicts',
  ]);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  function inline(value) {
    let text = escape(value);
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_all, label, href) =>
      `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`);
    text = text.replace(/(?<!["'=>])(https?:\/\/[^\s<)]+)/gi, (href) =>
      `<a href="${href}" target="_blank" rel="noreferrer noopener">${href}</a>`);
    return text;
  }

  function blockHtml(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    const output = [];
    let list = null;
    const closeList = () => {
      if (list) output.push(`</${list}>`);
      list = null;
    };
    for (const raw of lines) {
      const heading = raw.match(/^\s*(#{3,6})\s+(.+?)\s*$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 6);
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const checklist = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
      const unordered = raw.match(/^\s*[-*]\s+(.+)$/);
      const ordered = raw.match(/^\s*\d+\.\s+(.+)$/);
      if (checklist || unordered || ordered) {
        const type = ordered ? 'ol' : 'ul';
        if (list !== type) { closeList(); output.push(`<${type}>`); list = type; }
        if (checklist) {
          output.push(`<li class="report-check"><input type="checkbox" disabled ${checklist[1].trim() ? 'checked' : ''} aria-hidden="true"> ${inline(checklist[2])}</li>`);
        } else output.push(`<li>${inline((unordered || ordered)[1])}</li>`);
      } else {
        closeList();
        if (raw.trim()) output.push(`<p>${inline(raw.trim())}</p>`);
      }
    }
    closeList();
    return output.join('');
  }

  function parse(markdown) {
    const source = String(markdown || '').replace(/\r\n/g, '\n');
    const headings = [...source.matchAll(/^##\s+(.+?)\s*$/gm)];
    if (!headings.length) return { fallback: true, source };
    const title = source.match(/^#\s+(.+?)\s*$/m)?.[1] || 'Daily report';
    const sections = headings.map((match, index) => ({
      title: match[1].trim(),
      body: source.slice(match.index + match[0].length, headings[index + 1]?.index ?? source.length).trim(),
    }));
    return { fallback: false, title, sections };
  }

  function render(markdown) {
    const report = parse(markdown);
    if (report.fallback) return `<pre class="report-fallback">${escape(report.source)}</pre>`;
    return `<article class="daily-report" aria-labelledby="daily-report-title">
      <header class="daily-report-header"><p class="eyebrow">Daily report</p><h2 id="daily-report-title" tabindex="-1">${inline(report.title)}</h2></header>
      <div class="report-sections">${report.sections.map((section) => {
        const slug = section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `<section class="report-section ${KNOWN.has(section.title) ? 'report-section-known' : 'report-section-generic'} report-${slug}">
          <h3>${inline(section.title)}</h3>${blockHtml(section.body) || '<p class="meta">No entries.</p>'}
        </section>`;
      }).join('')}</div>
    </article>`;
  }

  global.ScoutReportView = Object.freeze({ parse, render });
})(globalThis);
