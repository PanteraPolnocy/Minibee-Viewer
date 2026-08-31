import * as esbuild from 'esbuild';
import { minify as minifyHtml } from 'html-minifier-terser';
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
  filter: (file) => !file.endsWith('.ts') && !file.endsWith('.css') && !file.endsWith('.html'),
});

// esbuild transforms each file on its own (no bundling), so a .ts input lands
// as the .js file the script tags already ask for, in the same place. Types
// are stripped, never checked - `npm run typecheck` is what checks them.
const entryPoints = findFiles(SRC, ['.ts', '.css']);

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

// Minify HTML files directly into dist
const htmlFiles = findFiles(SRC, ['.html']);
for (const file of htmlFiles) {
  const relativePath = path.relative(SRC, file);
  const distPath = path.join(DIST, relativePath);

  fs.mkdirSync(path.dirname(distPath), { recursive: true });

  const rawHtml = fs.readFileSync(file, 'utf8');
  const minifiedHtml = await minifyHtml(rawHtml, {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
  });

  fs.writeFileSync(distPath, minifiedHtml, 'utf8');
}

console.log(`[Build] Minification complete. Processed ${entryPoints.length} assets into dist/`);