/**
 * Indexes folders, in a process of its own.
 *
 * Reading a thousand headers is a thousand file opens and a thousand parses.
 * Done in the main process it blocks the event loop and the window stops
 * repainting — the application looks hung at exactly the moment it is working
 * hardest. Done in a renderer it would mean handing a page the file system.
 * A utility process is neither: it is Node, it has the disk, it has no window,
 * and if it dies it takes nothing with it.
 *
 * Everything it decides is in ./indexing, which knows nothing about processes
 * and can therefore be exercised without one. This file is the wiring.
 */
import { createIndexing } from './indexing';

import type { ToIndexer } from './messages';

const port = process.parentPort;
const indexing = createIndexing(message => port.postMessage(message));

port.on('message', event => indexing.handle(event.data as ToIndexer));
