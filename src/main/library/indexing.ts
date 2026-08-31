/**
 * What the indexing process does, without being a process.
 *
 * The awkward parts of reading a folder in the background are not about
 * processes at all: a second folder arriving before the first has finished, a
 * cancel that has to stop work already in flight, and eight readers that each
 * report one more file after nobody is listening any more. None of that needs
 * a channel to exercise, and all of it is easy to get wrong.
 *
 * So it lives here, taking a function to send with and a function to index
 * with, and the process itself is the ten lines that wire it to a real port.
 */
import { indexFolder, type IndexOptions, type IndexResult } from '../dicom/index-folder';

import type { FromIndexer, ToIndexer } from './messages';

export type Send = (message: FromIndexer) => void;
export type Index = (folder: string, options: IndexOptions) => Promise<IndexResult>;

export interface Indexing {
  handle(message: ToIndexer): void;
}

export function createIndexing(send: Send, index: Index = indexFolder): Indexing {
  let running: AbortController | undefined;

  return {
    handle(message: ToIndexer): void {
      if (message.type === 'cancel') {
        running?.abort();
        running = undefined;
        return;
      }

      if (message.type !== 'index') {
        return;
      }

      // A second folder arriving while one is still being read means the user
      // picked again. Finishing the first would send back a list for a folder
      // nobody is looking at any more.
      running?.abort();
      const controller = new AbortController();
      running = controller;

      const { folder } = message;

      // Progress on every file is a message per file, which on a fast disk
      // costs more than the reading does. Once per percent is smooth and
      // nearly free.
      let lastReported = -1;

      void index(folder, {
        signal: controller.signal,
        onProgress: (done, total) => {
          // The readers already in flight when a folder is abandoned each
          // finish their file and report it. Nobody is waiting for those
          // numbers, and sending them moves the bar of whatever is being read
          // now.
          if (controller.signal.aborted) {
            return;
          }

          const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
          if (percent !== lastReported || done === total) {
            lastReported = percent;
            send({ type: 'progress', folder, done, total });
          }
        },
      })
        .then(result => {
          if (controller.signal.aborted) {
            return;
          }
          send({
            type: 'done',
            folder,
            index: result.index,
            found: result.found,
            read: result.read,
            skipped: result.skipped,
            unreadable: result.unreadable,
            elapsedMs: result.elapsedMs,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          send({
            type: 'failed',
            folder,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    },
  };
}
