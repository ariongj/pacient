/**
 * Checks the web dictionaries (npm run i18n:check, also in CI):
 *  1. every literal t('…') / tn(…, '…', '…') text in apps/web/src has an Albanian and a Serbian
 *     translation;
 *  2. Albanian and Serbian define the same keys;
 *  3. no key is translated differently in two area files of the same language (the dictionaries
 *     are merged into one object, so the later file would silently win). When the same English
 *     word needs two translations, give one call site a context: t('Open|action');
 *  4. every module title, summary and page label of the navigation registry (modules.ts), which
 *     is translated where it is shown, has both translations.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/web/src/', import.meta.url));
/** Texts that are intentionally the same in every language. */
const UNTRANSLATED = new Set(['Pacient', '{count} result', '{count} results']);

type Dict = Record<string, string>;
const problems: string[] = [];

async function load(lang: 'sq' | 'sr') {
  const dir = join(root, 'i18n', lang);
  const index = readFileSync(join(dir, 'index.ts'), 'utf8');
  const order = [...index.matchAll(/^\s+\.\.\.(\w+),/gm)].map((m) => m[1]!);
  const fileOf = Object.fromEntries(
    [...index.matchAll(/^import \{ (\w+) \} from '\.\/([\w-]+)';/gm)].map((m) => [m[1], m[2]]),
  );
  const merged: Dict = {};
  const seen = new Map<string, { file: string; value: string }>();
  for (const name of order) {
    const file = fileOf[name];
    if (!file) throw new Error(`${lang}/index.ts spreads ${name} without importing it`);
    const mod = (await import(join(dir, `${file}.ts`))) as Record<string, Dict>;
    for (const [key, value] of Object.entries(mod[name]!)) {
      const prev = seen.get(key);
      if (prev && prev.value !== value) {
        problems.push(
          `${lang}: "${key}" is "${prev.value}" in ${prev.file}.ts but "${value}" in ${file}.ts`,
        );
      }
      seen.set(key, { file, value });
      merged[key] = value;
    }
  }
  const unregistered = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && f !== 'index.ts' && !Object.values(fileOf).includes(f.slice(0, -3)),
  );
  for (const f of unregistered) problems.push(`${lang}/${f} is not registered in index.ts`);
  return merged;
}

function sourceKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'i18n') walk(p);
      } else if (/\.tsx?$/.test(f)) {
        const src = readFileSync(p, 'utf8');
        const unesc = (s: string) => s.replace(/\\(['"\\])/g, '$1');
        for (const m of src.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
          keys.set(unesc(m[2]!), p.slice(root.length));
        }
        for (const m of src.matchAll(
          /\btn\(\s*[^,]+,\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3/g,
        )) {
          keys.set(unesc(m[2]!), p.slice(root.length));
          keys.set(unesc(m[4]!), p.slice(root.length));
        }
      }
    }
  };
  walk(root);
  return keys;
}

/** Titles, summaries and labels of the navigation registry (translated at render time). */
async function navigationKeys(): Promise<Map<string, string>> {
  const { NAVIGATION } = (await import(join(root, 'modules.ts'))) as {
    NAVIGATION: Record<
      string,
      {
        home: { label: string };
        modules: { title: string; summary: string; items: { label: string }[] }[];
      }
    >;
  };
  const keys = new Map<string, string>();
  for (const nav of Object.values(NAVIGATION)) {
    keys.set(nav.home.label, 'modules.ts');
    for (const m of nav.modules) {
      keys.set(m.title, 'modules.ts');
      keys.set(m.summary, 'modules.ts');
      for (const item of m.items) keys.set(item.label, 'modules.ts');
    }
  }
  return keys;
}

const sq = await load('sq');
const sr = await load('sr');
for (const [key, file] of [...sourceKeys(), ...(await navigationKeys())]) {
  if (UNTRANSLATED.has(key)) continue;
  if (!(key in sq)) problems.push(`sq: missing "${key}" (${file})`);
  if (!(key in sr)) problems.push(`sr: missing "${key}" (${file})`);
}
for (const key of Object.keys(sq))
  if (!(key in sr)) problems.push(`sr: no translation of "${key}"`);
for (const key of Object.keys(sr))
  if (!(key in sq)) problems.push(`sq: no translation of "${key}"`);

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} translation problem(s).`);
  process.exit(1);
}
console.log(`Translations OK: ${Object.keys(sq).length} texts in Albanian and Serbian.`);
