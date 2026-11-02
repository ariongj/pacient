import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('apps/web/dist');
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
]);
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden in the public artifact');
    if (entry.isDirectory()) {
      if (entry.name !== 'assets') throw new Error(`Unexpected artifact directory: ${entry.name}`);
      await inspect(full);
    } else {
      if (!allowed.has(path.extname(entry.name)) || entry.name.startsWith('.')) {
        throw new Error(`Unexpected artifact file: ${entry.name}`);
      }
      if (/\.(js|html|css)$/.test(entry.name)) {
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
