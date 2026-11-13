import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('apps/web/dist');
/** Bundled code and styles, and the app icons of the installable web app (manifest). */
const allowedDirs = new Set(['assets', 'icons']);
const allowed = new Set([
  '.html',
  '.js',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.webmanifest',
]);
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden in the public artifact');
    if (entry.isDirectory()) {
      if (!allowedDirs.has(entry.name) || dir !== out) {
        throw new Error(`Unexpected artifact directory: ${path.relative(out, full)}`);
      }
      await inspect(full);
    } else {
      if (!allowed.has(path.extname(entry.name)) || entry.name.startsWith('.')) {
        throw new Error(`Unexpected artifact file: ${entry.name}`);
      }
      if (/\.(js|html|css|webmanifest)$/.test(entry.name)) {
        const text = await readFile(full, 'utf8');
        if (
          /-----BEGIN .*PRIVATE KEY-----|postgres(?:ql)?:\/\/|sourceMappingURL=|sk-proj-/.test(text)
        ) {
          throw new Error(`Potential private material in public artifact: ${entry.name}`);
        }
      }
    }
  }
}
// Files this script writes itself: removed first, so a dry run can be repeated on one build.
for (const own of ['404.html', '.nojekyll', 'CNAME'])
  await rm(path.join(out, own), { force: true });
await inspect(out);
await copyFile(path.join(out, 'index.html'), path.join(out, '404.html'));
await writeFile(path.join(out, '.nojekyll'), '');
const domain = process.env.PAGES_CUSTOM_DOMAIN;
if (domain) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
    throw new Error('Invalid Pages custom domain');
  }
  await writeFile(path.join(out, 'CNAME'), `${domain}\n`);
}
console.log('Verified frontend-only Pages artifact; deep-link fallback prepared.');
