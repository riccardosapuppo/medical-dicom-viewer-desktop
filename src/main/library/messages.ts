/**
 * What the main process and the indexing process say to each other.
 *
 * They are in one file, shared by both sides, because a message shape that
 * lives in two places is a message shape that drifts — and the failure when it
 * does is a silent one, in a process with no window to report it.
 */
import type { Index } from '../dicom/build-index';
import type { UnreadableFile } from '../dicom/read-header';

/** Sent to the indexing process. */
export type ToIndexer = { type: 'index'; folder: string } | { type: 'cancel' };

/** Sent back from it. */
export type FromIndexer =
  | { type: 'progress'; done: number; total: number }
  | {
      type: 'done';
      folder: string;
      index: Index;
      read: number;
      skipped: number;
      unreadable: UnreadableFile[];
      elapsedMs: number;
    }
  | { type: 'failed'; folder: string; reason: string };
