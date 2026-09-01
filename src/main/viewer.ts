/**
 * Serves the viewer to the window.
 *
 * The viewer is the web one, built from its own repository and used as it is.
 * That is the point of this application: the same reading surface as the web
 * viewer, with a disc behind it instead of a server. Nothing here reimplements
 * any of it, and nothing here edits it either — a fork that has to be patched
 * to run on the desktop stops tracking the fork.
 *
 * A page loaded from `file:` would not do. The viewer routes inside itself, so
 * addresses that were never written to disc have to resolve to the application
 * anyway, and a file URL has no origin worth speaking of. So it is served from
 * a scheme of its own, and the two departures from serving plain files are:
 *
 *   - unknown paths return the page rather than a 404, because the address bar
 *     is the viewer's own state;
 *   - the configuration is rewritten on the way out, so the viewer reads from
 *     this machine's archive and from nowhere else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

export const VIEWER_SCHEME = 'viewer';

/** The one address the window ever loads. */
export const VIEWER_URL = `${VIEWER_SCHEME}://app/`;

const CONFIG = 'app-config.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function typeOf(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The configuration, redirected at the archive on this machine.
 *
 * The viewer's own configuration is eight hundred lines of decisions that took
 * a long time to get right, so it is served as it is and corrected afterwards
 * rather than replaced. Three corrections:
 *
 *   - the archive it reads from is the one this application just started, whose
 *     address is not known until then;
 *   - every other source is removed. The file lists public archives on the
 *     internet, which on a desktop reading station are both useless — there is
 *     no connection to assume — and wrong: this application opens the files in
 *     front of it and reaches nowhere else;
 *   - what it says when images will not load. Its own wording is about a
 *     session expiring, which is true in front of an archive that answers only
 *     while a token is valid, and false here.
 */
export function configureFor(original: string, archiveRoot: string): string {
  const tail = `
;(function () {
  var archive = ${JSON.stringify(archiveRoot)};
  var config = window.config;
  if (!config || !Array.isArray(config.dataSources)) {
    return;
  }

  var local = config.dataSources.filter(function (source) {
    return source && source.sourceName === 'dicomweb';
  });

  local.forEach(function (source) {
    source.configuration = Object.assign({}, source.configuration, {
      friendlyName: 'This computer',
      qidoRoot: archive,
      wadoRoot: archive,
      // The archive answers from an index it already holds, so a query may ask
      // for the fields it wants rather than reading every file to find them.
      qidoSupportsIncludeField: false,
      supportsFuzzyMatching: false,
      imageRendering: 'wadors',
      thumbnailRendering: 'wadors',
      singlepart: false,
      bulkDataURI: { enabled: true },
    });
  });

  // Nothing else. The others point at archives on the internet, and this
  // application reads the disc in front of it.
  config.dataSources = local;
  config.defaultDataSourceName = 'dicomweb';
  config.showStudyList = true;

  // There is no session here, so nothing can expire. The viewer's own wording
  // for a failed image fetch says otherwise, and full-screen: it is written for
  // an archive that answers only while a token is valid. What it means here is
  // that a file could not be read from the folder, which is what it now says.
  config.fetchErrorMessage = 'These images could not be read from the folder.';

  // One language across the whole application. The viewer chooses its own from
  // the machine, and everything around it here is in English, so on a computer
  // set to another language the menu bar and the worklist were English and the
  // viewer was not. Set before the viewer starts, which is what this file is: it
  // runs before its bundle.
  //
  // This does not reach the date drawn on the image. That is formatted with the
  // system's own locale, which is below anything a page can set.
  try {
    window.localStorage.setItem('i18nextLng', 'en-US');
  } catch (ignored) {
    // A window with no storage still gets a viewer, in whatever language it
    // decides for itself. Not worth refusing to start over.
  }
})();
`;

  return `${original}\n${tail}`;
}

/** Refuses an address that climbs out of the folder being served. */
function resolveWithin(root: string, requested: string): string | undefined {
  const full = path.resolve(root, `.${path.posix.normalize(requested)}`);
  const inside = full === root || full.startsWith(root + path.sep);
  return inside ? full : undefined;
}

export interface ViewerOptions {
  /** The built viewer: the folder holding its index.html. */
  folder: string;
  /** Where the viewer should read studies from. */
  archiveRoot: string;
}

/**
 * What the scheme is allowed to do, registered with every other scheme in one
 * call before the application is ready — the only moment it can be. Registered
 * later the scheme still resolves, but fetch refuses it and says nothing about
 * why.
 *
 * Standard so addresses parse into a host and a path, which the viewer's own
 * routing depends on. Secure so the page counts as a trustworthy origin, which
 * is what the graphics and worker APIs it uses require. Streamed so a hundred
 * megabytes of viewer arrive as they are read.
 */
export const VIEWER_PRIVILEGES = {
  scheme: VIEWER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
} as const;

/** Starts answering for `viewer://app/…`. */
export function serveViewer({ folder, archiveRoot }: ViewerOptions): void {
  const root = path.resolve(folder);
  const page = path.join(root, 'index.html');

  protocol.handle(VIEWER_SCHEME, async request => {
    const url = new URL(request.url);
    const wanted = decodeURIComponent(url.pathname);

    // The page starts by clearing out any service worker it registered on a
    // previous visit — housekeeping that only makes sense for the web
    // deployment. On a scheme of our own the browser refuses the call, so the
    // reading surface threw a security error on every single load. There is
    // nothing to clear here.
    //
    // Answered empty rather than allowed: letting the viewer register a worker
    // would let it cache its own bundle, which is the stale-bundle-after-an-
    // update that everything below sets no-store to prevent.
    if (wanted === '/init-service-worker.js') {
      return new Response('', {
        headers: { 'Content-Type': TYPES['.js'] as string, 'Cache-Control': 'no-store' },
      });
    }

    if (wanted === `/${CONFIG}`) {
      const original = await fs.promises.readFile(path.join(root, CONFIG), 'utf8');
      return new Response(configureFor(original, archiveRoot), {
        headers: { 'Content-Type': TYPES['.js'] as string, 'Cache-Control': 'no-store' },
      });
    }

    const file = resolveWithin(root, wanted);
    if (!file) {
      return new Response('Not found.', { status: 404 });
    }

    // The viewer navigates within itself, so most addresses it asks for were
    // never written to disc. Those are the page; a missing image is not.
    const asked = fs.existsSync(file) && fs.statSync(file).isFile() ? file : undefined;
    const target = asked ?? (path.extname(wanted) === '' ? page : undefined);

    if (!target) {
      return new Response('Not found.', { status: 404 });
    }

    const body = await net.fetch(pathToFileURL(target).toString());
    return new Response(body.body, {
      status: 200,
      headers: {
        'Content-Type': typeOf(target),
        // The window is the only reader, and a stale bundle after an update is
        // a bug report that takes a day to understand.
        'Cache-Control': 'no-store',
      },
    });
  });
}

/** True when a viewer has actually been built into `folder`. */
export function viewerPresent(folder: string): boolean {
  return fs.existsSync(path.join(folder, 'index.html'));
}
