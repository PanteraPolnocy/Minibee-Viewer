// Loads a frontend module for `node --test`.
//
// The frontend files are browser *scripts*, not ES modules: each one ends with
// a single top-level `const BeeThing = (function () { ... })()`. So there is
// nothing to import - we strip the types with esbuild (the very same transform
// the real build performs), evaluate the result in a function scope with
// stubbed browser globals, and hand back the module object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * @param {string} relPath   Path under src/, e.g. 'js/core/sl-slurl.ts'
 * @param {string} globalName The module's global, e.g. 'BeeSlurl'
 * @param {object} stubs     Globals to inject, keyed by name
 */
export function loadBeeModule(relPath, globalName, stubs = {}) {
  const source = fs.readFileSync(path.join(SRC, relPath), 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'ts',
    target: 'es2024',
  });
  const names = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${code}\n;return ${globalName};`);
  return factory(...names.map((n) => stubs[n]));
}
