// Il generatore dello studio di esempio e in TypeScript, e la build e in
// JavaScript: esbuild lo compila al volo, cosi non serve un passo in piu ne
// una copia del codice.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'make-sample.mjs');

await build({
  entryPoints: [path.join(root, 'tools', 'make-sample.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'warning',
});

export const { writeSample } = await import(pathToFileURL(out).href);
