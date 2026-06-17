const duplicateSectionHeadings = new Set(['segments', 'segment', 'timestamped segments', 'timestamps']);

export function compactMarkdownForRefinement(markdown) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const sections = splitMarkdownSections(lines);
  const transcriptSection = sections.find((section) => isHeading(section.heading, 'transcript'));

  if (transcriptSection) {
    const intro = lines.slice(0, transcriptSection.start).join('\n').trim();
    const transcript = sectionText(lines, transcriptSection).trim();
    return cleanMarkdown([intro, '## Transcript', transcript].filter(Boolean).join('\n\n'));
  }

  const keptSections = sections.filter((section) => !duplicateSectionHeadings.has(section.heading.toLowerCase()));
  if (!keptSections.length) {
    return cleanMarkdown(normalized);
  }

  const firstSectionStart = sections[0].start;
  const intro = lines.slice(0, firstSectionStart).join('\n').trim();
  const body = keptSections
    .map((section) => lines.slice(section.start, section.end).join('\n').trim())
    .filter(Boolean)
    .join('\n\n');

  return cleanMarkdown([intro, body].filter(Boolean).join('\n\n'));
}

function splitMarkdownSections(lines) {
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    if (sections.length) {
      sections[sections.length - 1].end = index;
    }

    sections.push({
      heading: match[1].trim(),
      start: index,
      end: lines.length
    });
  }

  return sections;
}

function sectionText(lines, section) {
  return lines.slice(section.start + 1, section.end).join('\n');
}

function isHeading(value, expected) {
  return value.trim().toLowerCase() === expected;
}

function cleanMarkdown(markdown) {
  return markdown
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
