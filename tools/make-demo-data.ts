/**
 * Writes the demo studies to a folder.
 *
 *   npm run demo-data                 into ./demo-data
 *   npm run demo-data -- /some/path   somewhere else
 *   npm run demo-data -- --replace    over whatever is there now
 *
 * The images are drawn from formulae. There is no patient here, and nothing in
 * this folder came from anybody.
 */
import fs from 'node:fs';
import path from 'node:path';

import { generate } from './demo-study';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const where = args.find(argument => !argument.startsWith('--'));
const target = path.resolve(where ?? 'demo-data');

if (fs.existsSync(target)) {
  if (!replace) {
    // Writing on top of an old folder leaves whatever was there before, and the
    // indexer would then report both sets as one library. Say so, and say what
    // to do about it — a refusal that does not is just an obstacle.
    process.stderr.write(
      `${target} already exists.\n` +
        `Pass --replace to write over it, or give another path:\n` +
        `  npm run demo-data -- --replace\n`
    );
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

const summary = generate(target);
const megabytes = (summary.bytes / (1024 * 1024)).toFixed(1);
const shown = path.relative(process.cwd(), summary.target) || summary.target;

process.stdout.write(`${summary.files} images, ${megabytes} MB, in ${shown}\n`);
