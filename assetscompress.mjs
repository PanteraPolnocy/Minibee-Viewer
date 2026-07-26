import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

// Helper to recursively find all JS and CSS files across any folder depth
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

// Clean previous build artifacts and recreate dist folder
if (fs.existsSync('dist')) {
  fs.rmSync('dist', { recursive: true, force: true });
}
fs.mkdirSync('dist', { recursive: true });

// Copy static assets (HTML, icons, fonts, etc.) preserving exact folder structure
fs.cpSync('src', 'dist', {
  recursive: true,
  filter: (file) => !file.endsWith('.js') && !file.endsWith('.css'),
});

// Collect all JS and CSS files (including deep subfolders like src/js/audio/*.js)
const entryPoints = findFiles('src', ['.js', '.css']);

// Minify files directly into dist/ while preserving relative folder hierarchy
if (entryPoints.length > 0) {
  await esbuild.build({
    entryPoints,
    outdir: 'dist',
    outbase: 'src',
    minify: true,
    sourcemap: false,
    target: 'es2022',
    drop: ['console', 'debugger'],
  });
}

console.log(`[Build] Minification complete. Processed ${entryPoints.length} assets into dist/`);
