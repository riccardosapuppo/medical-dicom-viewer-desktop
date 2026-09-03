/**
 * What the viewer scheme should answer for one address — decided here, and
 * answered next door.
 *
 * This lives in a file of its own, apart from `viewer.ts`, for one reason: that
 * file imports `electron`, and importing `electron` outside a running Electron
 * process throws. So every rule in here — that nothing is ever stored, that a
 * request naming a file which is not there is a 404 rather than the page, that
 * the viewer's own service-worker script is answered empty rather than allowed
 * — was correct and unreachable by any test, which is the same as unguarded.
 *
 * They are rules that come back, too. The single-page fallback especially: it
 * is one line, it looks like an obvious simplification, and it is why a missing
 * image can arrive as a page of HTML and a service worker can be handed the
 * application in place of its own manifest.
 */

import path from 'node:path';

/** The viewer's configuration file, rewritten on the way out. */
export const CONFIG = 'app-config.js';

/** Every answer this scheme gives carries it. */
export const NEVER_STORED = 'no-store';

export type WhatToServe =
  | { what: 'empty-script' }
  | { what: 'config' }
  | { what: 'file'; file: string }
  | { what: 'page'; file: string }
  | { what: 'not-found' };

/**
 * Resolves a requested path under `root`, or refuses.
 *
 * The `.` prefix and the posix normalise together mean a leading `/..` cannot
 * climb out: it is collapsed before it is joined. The containment check is
 * still here rather than trusted to that, because the two are cheap and the
 * consequence of being wrong is reading somebody's disc.
 */
export function resolveWithin(root: string, requested: string): string | undefined {
  const full = path.resolve(root, `.${path.posix.normalize(requested)}`);
  const inside = full === root || full.startsWith(root + path.sep);
  return inside ? full : undefined;
}

/**
 * `exists` is injected, so this can be asked about a disc that is not there.
 */
export function decideWhatToServe(
  wanted: string,
  { root, page, exists }: { root: string; page: string; exists: (file: string) => boolean }
): WhatToServe {
  // The page starts by clearing out any service worker it registered on a
  // previous visit — housekeeping that only makes sense for the web deployment.
  // On a scheme of our own the browser refuses the call, so the reading surface
  // threw a security error on every single load. There is nothing to clear.
  //
  // Answered empty rather than allowed: letting the viewer register a worker
  // would let it cache its own bundle, which is the stale-bundle-after-an-update
  // that everything else here sets no-store to prevent.
  if (wanted === '/init-service-worker.js') return { what: 'empty-script' };

  if (wanted === `/${CONFIG}`) return { what: 'config' };

  const file = resolveWithin(root, wanted);
  if (!file) return { what: 'not-found' };

  if (exists(file)) return { what: 'file', file };

  // The viewer navigates within itself, so most addresses it asks for were
  // never written to disc. Those are the page; a missing image is not.
  return path.extname(wanted) === '' ? { what: 'page', file: page } : { what: 'not-found' };
}
