/**
 * Indexes a folder, in a process of its own.
 *
 * Reading a thousand headers is a thousand file opens and a thousand parses.
 * Done in the main process it blocks the event loop and the window stops
 * repainting — the application looks hung at exactly the moment it is working
 * hardest. Done in a renderer it would mean handing a page the file system.
 * A utility process is neither: it is Node, it has the disk, it has no window,
 * and if it dies it takes nothing with it.
 *
 * It speaks only the messages in ./messages, and it never does anything with
 * the index beyond handing it back.
 */
import { indexFolder } from '../dicom/index-folder';

import type { FromIndexer, ToIndexer } from './messages';

const port = process.parentPort;

let running: AbortController | undefined;

function send(message: FromIndexer): void {
  port.postMessage(message);
}

port.on('message', event => {
  const message = event.data as ToIndexer;

  if (message.type === 'cancel') {
    running?.abort();
    return;
  }

  if (message.type !== 'index') {
    return;
  }

  // A second folder arriving while one is still being read means the user
  // picked again. Finishing the first would send back an index for a folder
  // nobody is looking at any more.
  running?.abort();
  const controller = new AbortController();
  running = controller;

  const { folder } = message;

  // Progress on every file is a message per file, which on a fast disk costs
  // more than the reading does. Once per percent is smooth and nearly free.
  let lastReported = -1;

  indexFolder(folder, {
    signal: controller.signal,
    onProgress: (done, total) => {
      const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
      if (percent !== lastReported || done === total) {
        lastReported = percent;
        send({ type: 'progress', done, total });
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
});
