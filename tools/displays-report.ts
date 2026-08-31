/**
 * Prints the desk and exits. Opens no window.
 *
 * This is the first thing the project does, and it is deliberately the smallest
 * useful thing: before placing anything on a screen, be able to say what the
 * screens are and recognise the same arrangement tomorrow. Everything the
 * workstation does afterwards is built on this reading being right.
 *
 *   npm run displays
 *   npm run displays -- --json
 */
import { app, screen } from 'electron';

import { describe, fingerprint, readTopology } from '../src/main/display-topology';

const asJson = process.argv.includes('--json');

// Electron obeys ELECTRON_RUN_AS_NODE from the surrounding shell: with it set,
// the binary starts as plain Node, `app` is undefined, and all you get back is
// "Cannot read properties of undefined". It costs four lines to say it plainly.
if (!app) {
  process.stderr.write(
    'Electron started as plain Node, where neither app nor screen exists.\n' +
      'ELECTRON_RUN_AS_NODE is set in the environment: clear it and try again.\n'
  );
  process.exit(1);
}

app.whenReady().then(() => {
  const topology = readTopology(screen);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ...topology, fingerprint: fingerprint(topology) }, null, 2)}\n`
    );
  } else {
    process.stdout.write(`\n${describe(topology)}\n\n`);
  }

  app.exit(0);
});
