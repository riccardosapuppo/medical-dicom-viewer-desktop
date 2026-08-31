/**
 * Walks a folder and indexes every DICOM file under it.
 *
 * Two things this does not do, on purpose. It does not stop at the first file
 * it cannot read: someone dragging in a folder from a CD gets viewer software,
 * autorun files, thumbnails and a readme along with the images, and a study
 * that refuses to open because of a stray JPEG is a study nobody can read. And
 * it does not open the files one after another — a spinning disk and a network
 * share both want several requests in flight, and a few at a time is the
 * difference between seconds and minutes on a large study.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { buildIndex, type Index } from './build-index';
import { NotDicomError, readHeader, type InstanceHeader, type UnreadableFile } from './read-header';

/** Enough requests in flight to keep a disk busy, few enough to keep handles free. */
const CONCURRENCY = 8;

/**
 * The directory record at the root of a DICOM CD. It is a valid DICOM file that
 * describes the others, and indexing it would add a phantom study made of
 * pointers.
 */
const DIRECTORY_RECORD = 'dicomdir';

export interface IndexResult {
  index: Index;
  /** Files the walk found, before any of them were opened. */
  found: number;
  /** Files that parsed. */
  read: number;
  /** Files that were not DICOM at all — ordinary, and not an error. */
  skipped: number;
  /** Files that looked like DICOM and would not parse. These are worth showing. */
  unreadable: UnreadableFile[];
  /** Milliseconds spent, for the log line that says whether this is slow. */
  elapsedMs: number;
}

export interface IndexOptions {
  /** Called as files are read, so a long walk can say something. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Every file under a directory, depth first, symlinks not followed. */
async function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Checked inside the loop, not only at the top: somebody who drops a
      // drive root and then presses Stop is waiting on a walk that has not
      // reached its first file yet, and a cancel that only takes effect once
      // the walk finishes is not a cancel.
      if (signal?.aborted) {
        return;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase() !== DIRECTORY_RECORD) {
        found.push(full);
      }
    }
  }

  await walk(root);
  // Sorted so that two runs over one folder do the same work in the same order,
  // which matters when something goes wrong on file four hundred.
  return found.sort();
}

/**
 * What went wrong with the folder itself, in a sentence.
 *
 * The message Node raises is accurate and unreadable: it names a syscall and
 * quotes the path twice. Someone who dropped the wrong thing on the window
 * needs to know which of three things happened, and the raw text is kept for
 * whoever is looking at a log.
 */
function explainFolderError(root: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);

  if (code === 'ENOENT') {
    return `There is nothing at ${root}.`;
  }
  if (code === 'ENOTDIR') {
    return `${root} is a file, not a folder. Open the folder that contains it.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `${root} cannot be read: the system refused permission.`;
  }
  return detail;
}

export async function indexFolder(root: string, options: IndexOptions = {}): Promise<IndexResult> {
  const startedAt = process.hrtime.bigint();

  let files: string[];
  try {
    files = await listFiles(root, options.signal);
  } catch (error) {
    throw new Error(explainFolderError(root, error));
  }

  // Written by position rather than appended: with eight workers in flight the
  // order they finish in is the order the disk happens to answer in, and the
  // first header of a series decides its description, its modality and the
  // spelling of the patient's name. Two runs over one folder were producing
  // two different indexes.
  const inOrder: Array<InstanceHeader | undefined> = new Array(files.length);
  const unreadable: UnreadableFile[] = [];
  let skipped = 0;
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= files.length || options.signal?.aborted) {
        return;
      }
      const filePath = files[i] as string;

      try {
        inOrder[i] = await readHeader(filePath);
      } catch (error) {
        if (error instanceof NotDicomError) {
          skipped++;
        } else {
          unreadable.push({
            filePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      options.onProgress?.(++done, files.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  const headers = inOrder.filter((header): header is InstanceHeader => header !== undefined);

  return {
    index: buildIndex(headers),
    found: files.length,
    read: headers.length,
    skipped,
    unreadable,
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  };
}
