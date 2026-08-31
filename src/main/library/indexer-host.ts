/**
 * The main process end of the indexing process.
 *
 * Starts it lazily, keeps one of them, restarts it if it dies, and turns its
 * messages into callbacks. Everything about the child being a separate process
 * stops here: the rest of the application asks for a folder to be read and gets
 * progress and a result.
 */
import path from 'node:path';

import { utilityProcess, type UtilityProcess } from 'electron';

import type { FromIndexer, ToIndexer } from './messages';

/** Built alongside the main process by tools/build-app.mjs. */
const CHILD = path.join(__dirname, 'indexer.js');

export type IndexerListener = (message: FromIndexer) => void;

export class Indexer {
  #child: UtilityProcess | undefined;
  #listeners = new Set<IndexerListener>();
  /** What is being read right now, so a crash can say which folder was lost. */
  #folder: string | undefined;

  /** Adds a listener and hands back the function that removes it. */
  on(listener: IndexerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(message: FromIndexer): void {
    for (const listener of this.#listeners) {
      listener(message);
    }
  }

  #spawn(): UtilityProcess {
    const child = utilityProcess.fork(CHILD, [], { serviceName: 'dicom-indexer' });

    child.on('message', (message: FromIndexer) => {
      if (message.type !== 'progress') {
        this.#folder = undefined;
      }
      this.#emit(message);
    });

    // A child that dies mid-folder leaves the window waiting on a progress bar
    // that will never move again. Say so, and forget the child so the next
    // request starts a fresh one.
    child.on('exit', code => {
      this.#child = undefined;
      if (this.#folder !== undefined) {
        this.#emit({
          type: 'failed',
          folder: this.#folder,
          reason: `the indexing process stopped (exit ${code}) partway through this folder`,
        });
        this.#folder = undefined;
      }
    });

    this.#child = child;
    return child;
  }

  #send(message: ToIndexer): void {
    (this.#child ?? this.#spawn()).postMessage(message);
  }

  read(folder: string): void {
    this.#folder = folder;
    this.#send({ type: 'index', folder });
  }

  cancel(): void {
    if (this.#child) {
      this.#folder = undefined;
      this.#send({ type: 'cancel' });
    }
  }

  /** Stops the child. Called when the application quits. */
  stop(): void {
    this.#folder = undefined;
    this.#child?.kill();
    this.#child = undefined;
  }
}
