import type { ReactNode } from 'react';

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string };

/** Splits the plain-text format: "# " headings, "- " list items, blank lines between paragraphs. */
export function parseLegalText(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (line.startsWith('# ')) {
      flush();
      blocks.push({ kind: 'heading', text: line.slice(2).trim() });
    } else if (line.startsWith('- ')) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list') last.items.push(line.slice(2).trim());
      else blocks.push({ kind: 'list', items: [line.slice(2).trim()] });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Shows a terms of use or privacy notice text as headings, lists and paragraphs. Rendered as
 * React elements only (no HTML from the text is ever interpreted).
 */
export function LegalText({ body, level = 2 }: { body: string; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="legal-text">
      {parseLegalText(body).map((b, i): ReactNode => {
        if (b.kind === 'heading') return <Heading key={i}>{b.text}</Heading>;
        if (b.kind === 'list') {
          return (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{b.text}</p>;
      })}
    </div>
  );
}
