/**
 * A folder on this machine, served as a DICOMweb archive.
 *
 * This is what lets the desktop application ship the same viewer as the web one
 * rather than a second implementation of it. The viewer already knows how to
 * read a DICOMweb archive; the desktop side's job is to be one, over a folder
 * chosen from a disc, with nothing installed and nothing configured.
 *
 * Three deliberate choices about the socket:
 *
 *   - it is bound to `127.0.0.1`, not to every interface. A study open on a
 *     laptop must not become readable to the coffee shop's network.
 *   - the port is whatever the operating system hands out, because a fixed one
 *     collides with whatever else the machine is running.
 *   - every address sits under a secret generated at startup. Loopback is not a
 *     boundary on a shared machine: any other process can walk the ports. The
 *     secret means guessing the port is not enough, and it never leaves the
 *     application — the window is told it, and nothing else is.
 *
 * The archive is read-only. There is no STOW-RS: nothing here writes to the
 * patient's files.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Index, Instance } from '../dicom/build-index';
import { isProblem, readFrame } from './frames';
import { readInstance } from './metadata';
import type { JsonDataset } from './metadata';
import {
  allSeriesQuery,
  applyFilters,
  instanceQuery,
  readFilters,
  seriesQuery,
  studyQuery,
} from './qido';

const JSON_TYPE = 'application/dicom+json';

/** What the window needs to be told to reach the archive. */
export interface Archive {
  /** Where queries go. The viewer's configuration wants this and `wadoRoot`. */
  root: string;
  /** Stops listening and forgets everything read. */
  close(): Promise<void>;
  /** Points the archive at a different folder, without restarting anything. */
  serve(index: Index): void;
}

/**
 * One instance in the currently open folder, found by its three names.
 *
 * Only images in the folder that is open can be found. A study elsewhere on the
 * disc is a 404 here, whatever the address says — the window cannot name a path,
 * so it cannot ask for one.
 */
function locate(
  index: Index,
  studyUid: string,
  seriesUid: string,
  instanceUid: string
): Instance | undefined {
  for (const patient of index.patients) {
    for (const study of patient.studies) {
      if (study.studyInstanceUid !== studyUid) {
        continue;
      }
      for (const series of study.series) {
        if (series.seriesInstanceUid !== seriesUid) {
          continue;
        }
        const instance = series.instances.find(one => one.sopInstanceUid === instanceUid);
        if (instance) {
          return instance;
        }
      }
    }
  }
  return undefined;
}

/** Every file belonging to a series, or to a whole study. */
function filesOf(index: Index, studyUid: string, seriesUid?: string): string[] {
  const files: string[] = [];
  for (const patient of index.patients) {
    for (const study of patient.studies) {
      if (study.studyInstanceUid !== studyUid) {
        continue;
      }
      for (const series of study.series) {
        if (seriesUid !== undefined && series.seriesInstanceUid !== seriesUid) {
          continue;
        }
        for (const instance of series.instances) {
          files.push(instance.filePath);
        }
      }
    }
  }
  return files;
}

function sendJson(response: http.ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': Buffer.byteLength(text),
    // The window runs on a different scheme from this socket, so the browser
    // treats every request as cross-origin and asks first.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

function sendProblem(response: http.ServerResponse, status: number, reason: string): void {
  // A refusal says why. A viewer given an empty 200 draws nothing and reports
  // nothing, and the person in front of it is left guessing.
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(reason);
}

/**
 * One frame, wrapped as the single part of a multipart response.
 *
 * WADO-RS returns frames this way even when there is only one of them, and the
 * part's content type is how the viewer learns whether the bytes need
 * decompressing.
 */
function sendFrame(
  response: http.ServerResponse,
  bytes: Buffer,
  mediaType: string,
  location: string
): void {
  const boundary = `dicomweb-${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: ${mediaType}\r\n` +
      `Content-Location: ${location}\r\n` +
      `\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  response.writeHead(200, {
    'Content-Type': `multipart/related; type="${mediaType}"; boundary=${boundary}`,
    'Content-Length': head.length + bytes.length + tail.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  response.end(Buffer.concat([head, bytes, tail]));
}

/**
 * Starts the archive.
 *
 * Resolves once the socket is listening, so whoever asked knows the address
 * before the window is told to load anything.
 */
export function startArchive(index: Index): Promise<Archive> {
  let current = index;
  const secret = crypto.randomBytes(16).toString('hex');

  // Headers read once per file and kept. A series is asked for its metadata
  // whenever it is opened, and re-reading three hundred headers each time is a
  // pause the person watching would feel.
  const headers = new Map<string, JsonDataset | null>();

  // Filled in once the socket is listening. Every address the archive hands out
  // is built from it, so it has to be the real port rather than the one asked
  // for, which was zero.
  let root = '';

  /**
   * Answers one request.
   *
   * Wrapped below rather than left bare. A fault in here used to leave the
   * socket open with nothing written to it, and the viewer waited on an answer
   * that was never coming — a worse failure than an error, because nothing
   * anywhere says that something is wrong.
   */
  function handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Content-Type',
      });
      response.end();
      return;
    }

    if (request.method !== 'GET') {
      // Read-only on purpose: this serves a person's own files, and nothing
      // here should be able to alter them.
      sendProblem(response, 405, 'This archive is read-only.');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const prefix = `/${secret}/dicom-web`;
    if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) {
      sendProblem(response, 404, 'Not found.');
      return;
    }

    const parts = url.pathname
      .slice(prefix.length)
      .split('/')
      .filter(part => part.length > 0)
      .map(part => decodeURIComponent(part));

    // /studies
    if (parts.length === 1 && parts[0] === 'studies') {
      sendJson(response, applyFilters(studyQuery(current, root), readFilters(url.searchParams)));
      return;
    }

    // /series — every series in the folder, which the viewer asks for when it
    // wants a flat list rather than a study at a time.
    if (parts.length === 1 && parts[0] === 'series') {
      sendJson(response, allSeriesQuery(current, root));
      return;
    }

    if (parts[0] !== 'studies' || parts.length < 2) {
      sendProblem(response, 404, 'Not found.');
      return;
    }
    const studyUid = parts[1] as string;

    /** Reads a set of files as metadata, using anything already read. */
    const metadataFor = (files: string[]): JsonDataset[] => {
      const out: JsonDataset[] = [];
      for (const file of files) {
        if (!headers.has(file)) {
          const read = readInstance(file, root);
          headers.set(file, read ? read.dataset : null);
        }
        const dataset = headers.get(file);
        if (dataset) {
          out.push(dataset);
        }
      }
      return out;
    };

    // /studies/{study}/metadata
    if (parts.length === 3 && parts[2] === 'metadata') {
      sendJson(response, metadataFor(filesOf(current, studyUid)));
      return;
    }

    // /studies/{study}/series
    if (parts.length === 3 && parts[2] === 'series') {
      sendJson(
        response,
        applyFilters(seriesQuery(current, studyUid, root), readFilters(url.searchParams))
      );
      return;
    }

    if (parts[2] !== 'series' || parts.length < 4) {
      sendProblem(response, 404, 'Not found.');
      return;
    }
    const seriesUid = parts[3] as string;

    // /studies/{study}/series/{series}/metadata
    if (parts.length === 5 && parts[4] === 'metadata') {
      sendJson(response, metadataFor(filesOf(current, studyUid, seriesUid)));
      return;
    }

    // /studies/{study}/series/{series}/instances
    if (parts.length === 5 && parts[4] === 'instances') {
      sendJson(response, instanceQuery(current, studyUid, seriesUid, root));
      return;
    }

    if (parts[4] !== 'instances' || parts.length < 6) {
      sendProblem(response, 404, 'Not found.');
      return;
    }
    const instanceUid = parts[5] as string;
    const found = locate(current, studyUid, seriesUid, instanceUid);

    if (!found) {
      // Asking for an image that is not in the folder currently open is a 404,
      // whatever else it might be somewhere on the disc.
      sendProblem(response, 404, 'That image is not in the open folder.');
      return;
    }

    // /studies/{study}/series/{series}/instances/{instance}/metadata
    if (parts.length === 7 && parts[6] === 'metadata') {
      sendJson(response, metadataFor([found.filePath]));
      return;
    }

    // /studies/{study}/series/{series}/instances/{instance}/frames/{numbers}
    if (parts.length === 8 && parts[6] === 'frames') {
      // The standard allows several frames in one request. The viewer asks for
      // one at a time, and serving the first of a list is a quiet wrong answer,
      // so a list is refused rather than half-answered.
      const asked = (parts[7] as string).split(',');
      if (asked.length !== 1) {
        sendProblem(response, 400, 'One frame per request.');
        return;
      }

      const frame = readFrame(found.filePath, found.pixels, Number(asked[0]));
      if (isProblem(frame)) {
        sendProblem(response, frame.status, frame.reason);
        return;
      }

      sendFrame(response, frame.bytes, frame.mediaType, url.href);
      return;
    }

    sendProblem(response, 404, 'Not found.');
  }

  const server = http.createServer((request, response) => {
    try {
      handle(request, response);
    } catch (problem) {
      const detail = problem instanceof Error ? problem.message : 'unknown';
      if (response.headersSent) {
        // Half an answer has already gone out; there is no way to correct it, so
        // the connection is cut rather than left to look complete.
        response.destroy();
      } else {
        sendProblem(response, 500, `The archive could not answer that: ${detail}`);
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);

    // Loopback only, and a port the operating system picks.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.removeListener('error', reject);
      root = `http://127.0.0.1:${port}/${secret}/dicom-web`;

      resolve({
        root,
        serve(next: Index) {
          current = next;
          // A different folder is a different set of files. Keeping headers
          // read from the last one would answer for images no longer open.
          headers.clear();
        },
        close() {
          return new Promise<void>(done => {
            headers.clear();
            server.close(() => done());
            // Anything still connected is dropped: the window is going away and
            // the socket must not outlive it.
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}
