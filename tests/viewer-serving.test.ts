/**
 * How the viewer scheme answers, held down by something.
 *
 * The rules were all correct and none of them was guarded. That is a worse
 * position than it sounds: the handler needs Electron's `protocol` and `net`,
 * so no test could reach it, and every one of these behaviours is the sort that
 * comes back the moment somebody simplifies the function — the single-page
 * fallback in particular, which is one line and looks like an obvious
 * improvement until a missing image arrives as a page of HTML.
 *
 * The decision is now a pure function and this asks it directly.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { decideWhatToServe, NEVER_STORED } from '../src/main/viewer';

const root = path.resolve('C:/viewer');
const page = path.join(root, 'index.html');

/** A disc where only these paths are files. */
function discWith(...files: string[]) {
  const there = new Set(files.map((one) => path.resolve(root, one)));
  return (file: string) => there.has(path.resolve(file));
}

describe('what the viewer scheme answers', () => {
  it('serves a file that is really there', () => {
    const said = decideWhatToServe('/main.js', { root, page, exists: discWith('main.js') });

    assert.equal(said.what, 'file');
    assert.equal(said.what === 'file' ? said.file : '', path.join(root, 'main.js'));
  });

  it('serves the page for an address the viewer routes to itself', () => {
    // The viewer navigates within itself, so most addresses it asks for were
    // never written to disc.
    const said = decideWhatToServe('/study/1.2.840/series', { root, page, exists: discWith() });

    assert.equal(said.what, 'page');
    assert.equal(said.what === 'page' ? said.file : '', page);
  });

  it('but a request that NAMES A FILE and has not got one is not the page', () => {
    // This is the whole point. `try_files … /index.html` answering /ngsw.json
    // with a page of HTML is how a service worker ends up treating the
    // application as its own manifest, and how a missing script fails later,
    // somewhere else, with a syntax error on line 1.
    for (const named of ['/ngsw.json', '/missing.png', '/chunk-NEVER-BUILT.js', '/assets/gone.woff2']) {
      assert.equal(decideWhatToServe(named, { root, page, exists: discWith() }).what, 'not-found', named);
    }
  });

  it('answers the viewer’s service-worker script empty rather than allowing it', () => {
    // Allowing it would let the viewer cache its own bundle, which is the
    // stale-bundle-after-an-update that everything else here prevents.
    assert.equal(
      decideWhatToServe('/init-service-worker.js', { root, page, exists: discWith() }).what,
      'empty-script'
    );
  });

  it('and does so even if a file of that name is sitting there', () => {
    assert.equal(
      decideWhatToServe('/init-service-worker.js', { root, page, exists: discWith('init-service-worker.js') }).what,
      'empty-script'
    );
  });

  it('rewrites the configuration rather than serving it as it is on disc', () => {
    assert.equal(decideWhatToServe('/app-config.js', { root, page, exists: discWith('app-config.js') }).what, 'config');
  });

  it('never resolves to anything outside the folder, whatever is asked for', () => {
    // Written as "these must be refused" first, and that was the wrong
    // assertion: `path.posix.normalize` collapses a leading `/..` to `/`, so
    // `/../secrets.env` is not an escape at all — it is a request for a file
    // inside the folder, and serving it is correct. What actually matters is
    // not which answer comes back but that the file named in it is always
    // under the root, so that is what this says.
    for (const asked of [
      '/../secrets.env',
      '/../../Windows/System32/config/SAM',
      '/..%2f..%2fetc/passwd',
      '/study/../../../etc/passwd',
      '/./././../../outside.js',
    ]) {
      const said = decideWhatToServe(asked, { root, page, exists: () => true });

      if (said.what !== 'file' && said.what !== 'page') continue;

      const resolved = path.resolve(said.file);
      assert.ok(
        resolved === root || resolved.startsWith(root + path.sep),
        `${asked} resolved to ${resolved}, which is outside ${root}`
      );
    }
  });

  it('and nothing it serves is ever stored', () => {
    // The constant is what the handler actually sets; asserting the string here
    // and the constant there is the arrangement where they can disagree.
    assert.equal(NEVER_STORED, 'no-store');
  });
});
