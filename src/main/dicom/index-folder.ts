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
const DIRECTORY_RECORD = 'DICOMDIR';

export interface IndexResult {
  index: Index;
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
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name !== DIRECTORY_RECORD) {
        found.push(full);
      }
    }
  }

  await walk(root);
  // Sorted so that two runs over one folder do the same work in the same order,
  // which matters when something goes wrong on file four hundred.
  return found.sort();
}

export async function indexFolder(root: string, options: IndexOptions = {}): Promise<IndexResult> {
  const startedAt = process.hrtime.bigint();
  const files = await listFiles(root);

  const headers: InstanceHeader[] = [];
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
        headers.push(await readHeader(filePath));
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

  return {
    index: buildIndex(headers),
    read: headers.length,
    skipped,
    unreadable,
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  };
}
