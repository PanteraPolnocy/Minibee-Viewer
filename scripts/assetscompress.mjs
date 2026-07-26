import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

function findFiles(dir, extensions) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }

  return results;
}

if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

fs.cpSync(SRC, DIST, {
  recursive: true,
  filter: (file) => !file.endsWith('.js') && !file.endsWith('.css'),
});

const entryPoints = findFiles(SRC, ['.js', '.css']);

if (entryPoints.length > 0) {
  await esbuild.build({
    entryPoints,
    outdir: DIST,
    outbase: SRC,
    minify: true,
    sourcemap: false,
    target: 'es2024',
    drop: ['console', 'debugger'],
  });
}

console.log(`[Build] Minification complete. Processed ${entryPoints.length} assets into dist/`);
