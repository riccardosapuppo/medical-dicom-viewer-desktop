/**
 * The folder being read, and what came back.
 *
 * All the awkwardness of an operation that takes seconds lives here: it can be
 * running, it can be replaced by another one before it finishes, it can fail,
 * and the answer arrives in pieces over a channel rather than as a returned
 * value. The components below get a single state to render and nothing to
 * coordinate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Index } from '../main/dicom/build-index';
import type { UnreadableFile } from '../main/dicom/read-header';

export interface LibraryReading {
  folder: string;
  index: Index;
  found: number;
  read: number;
  skipped: number;
  unreadable: UnreadableFile[];
  elapsedMs: number;
}

export type LibraryState =
  | { status: 'empty' }
  | { status: 'reading'; folder: string; done: number; total: number }
  | { status: 'ready'; reading: LibraryReading }
  | { status: 'failed'; folder: string; reason: string };

export interface Library {
  state: LibraryState;
  /** The folder chooser. */
  open: () => void;
  /** The file chooser: a study is often handed over as loose files. */
  openFiles: () => void;
  /** The study that ships inside the application. */
  openSample: () => void;
  read: (folder: string) => void;
  cancel: () => void;
  /** Puts the worklist away without opening anything else. */
  close: () => void;
}

export function useLibrary(): Library {
  const [state, setState] = useState<LibraryState>({ status: 'empty' });

  // Which folder the window is currently interested in. A message about any
  // other one is the tail of a reading that was replaced, and rendering it
  // would swap the list back to the folder the user just left.
  const wanted = useRef<string | undefined>(undefined);

  /**
   * The folder that is already open, asked for once when this page starts.
   *
   * The page is loaded fresh every time the window comes back from the viewer,
   * and without this it came back to the opening screen — the folder still
   * open, the archive still serving it, and the worklist showing nothing. What
   * that looks like is an application that lost the study you were reading.
   */
  useEffect(() => {
    let stillHere = true;

    void window.workstation.currentReading().then(current => {
      const reading = current as LibraryReading | undefined;
      if (!stillHere || !reading || wanted.current !== undefined) {
        // Nothing open, or somebody picked a folder while this was in flight.
        // The folder they just chose wins over the one that was already there.
        return;
      }

      wanted.current = reading.folder;
      setState({ status: 'ready', reading });
    });

    return () => {
      stillHere = false;
    };
  }, []);

  useEffect(
    () =>
      window.workstation.onLibrary(message => {
        // The folder is checked first, for every kind of message. Progress used
        // to skip this test, so the tail of an abandoned read drove the bar of
        // the folder that replaced it.
        if (message.folder !== wanted.current) {
          return;
        }

        if (message.type === 'progress') {
          setState(current =>
            current.status === 'reading'
              ? { ...current, done: message.done, total: message.total }
              : current
          );
          return;
        }

        if (message.type === 'failed') {
          setState({ status: 'failed', folder: message.folder, reason: message.reason });
          return;
        }

        setState({
          status: 'ready',
          reading: {
            folder: message.folder,
            index: message.index,
            found: message.found,
            read: message.read,
            skipped: message.skipped,
            unreadable: message.unreadable,
            elapsedMs: message.elapsedMs,
          },
        });
      }),
    []
  );

  const read = useCallback((folder: string) => {
    wanted.current = folder;
    setState({ status: 'reading', folder, done: 0, total: 0 });
    void window.workstation.readFolder(folder);
  }, []);

  const open = useCallback(() => {
    void window.workstation.chooseFolder().then(folder => {
      if (folder) {
        read(folder);
      }
    });
  }, [read]);

  const openFiles = useCallback(() => {
    void window.workstation.chooseFiles().then(folder => {
      if (folder) {
        read(folder);
      }
    });
  }, [read]);

  const openSample = useCallback(() => {
    void window.workstation.sampleFolder().then(read);
  }, [read]);

  const close = useCallback(() => {
    wanted.current = undefined;
    setState({ status: 'empty' });
  }, []);

  const cancel = useCallback(() => {
    wanted.current = undefined;
    void window.workstation.cancelReading();
    setState({ status: 'empty' });
  }, []);

  // A folder named on the command line, or handed over by a second launch.
  // Registered after `read` exists so the listener always has the current one.
  useEffect(() => window.workstation.onOpenRequest(read), [read]);

  return { state, open, openFiles, openSample, read, cancel, close };
}
