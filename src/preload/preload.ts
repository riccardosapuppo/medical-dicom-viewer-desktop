/**
 * The whole of what the renderer can reach.
 *
 * The page runs with context isolation on, node integration off and the sandbox
 * on, so it has no file system, no child processes and no Electron API of its
 * own. Everything it can do is listed here, by name, and each entry is a
 * question the main process chooses how to answer. A viewer that renders
 * whatever a study contains has no business being able to read the disk
 * directly, and this is where that is decided rather than hoped for.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

/** Put here by the build, from package.json. */
declare const __APP_VERSION__: string;

import type { Desk } from '../main/display-topology';
import type { FromIndexer } from '../main/library/messages';

const api = {
  /** The desk as it is right now. */
  readDesk: (): Promise<Desk> => ipcRenderer.invoke('desk:read'),

  /**
   * Called when a monitor is plugged, unplugged or rescaled.
   *
   * Returns the function that stops listening. Handing it back rather than
   * offering a matching `off` means a caller cannot accidentally remove someone
   * else's listener, and a component that forgets to clean up shows as a leak
   * in one place instead of a wrong-window bug somewhere else.
   */
  onDeskChanged: (handler: (desk: Desk) => void): (() => void) => {
    const listener = (_event: unknown, desk: Desk): void => handler(desk);
    ipcRenderer.on('desk:changed', listener);
    return () => ipcRenderer.off('desk:changed', listener);
  },

  /** Opens the folder chooser. Resolves to undefined if the user changed their mind. */
  chooseFolder: (): Promise<string | undefined> => ipcRenderer.invoke('library:choose'),

  /** Starts reading a folder. Everything after this arrives through onLibrary. */
  readFolder: (folder: string): Promise<void> => ipcRenderer.invoke('library:read', folder),

  cancelReading: (): Promise<void> => ipcRenderer.invoke('library:cancel'),

  /**
   * What the application currently has open.
   *
   * A window opened on another screen asks this rather than being told, so it
   * can start from whatever it finds instead of waiting for a message that may
   * arrive before or after it is ready.
   */
  currentReading: (): Promise<unknown> => ipcRenderer.invoke('library:current'),

  /** Opens a series in its own window on the given pane of the desk. */
  openOnScreen: (studyInstanceUid: string, pane: number): Promise<void> =>
    ipcRenderer.invoke('reading:open', studyInstanceUid, pane),

  closeReading: (studyInstanceUid: string): Promise<void> =>
    ipcRenderer.invoke('reading:close', studyInstanceUid),

  /** Which screen this desk last had this series on, if any. */
  recallScreen: (studyInstanceUid: string): Promise<number | undefined> =>
    ipcRenderer.invoke('reading:recall', studyInstanceUid),

  /** Reopens the arrangement this desk remembers. Resolves to how many windows opened. */

  /** Opens the file chooser. Resolves to the folder the chosen files are in. */
  chooseFiles: (): Promise<string | undefined> => ipcRenderer.invoke('library:chooseFiles'),

  /** The folders opened before, newest first. */
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('library:recent'),

/**
   * Where the demonstration studies are, if they have been downloaded.
   *
   * Nothing ships inside the application: what used to be here was drawn from a
   * formula, and `npm run demo-data` fetches real acquisitions instead. Absent
   * until it has been run, and always absent in an installed copy, which has no
   * project directory to put them in.
   */
  sampleFolder: (): Promise<string | undefined> => ipcRenderer.invoke('library:sample'),

  /**
   * Whether the viewer has been built into this copy.
   *
   * It is fetched and built rather than kept in the repository, so a clone that
   * has not run `npm run viewer` has an application with no reading surface.
   * Asking lets the opening screen say so, instead of a folder opening onto a
   * window that goes blank.
   */
  /**
   * A folder a menu asked for while this page did not exist.
   *
   * The menu belongs to the main process; the worklist belongs to here. While a
   * study is open there is no page to send to, so the request waits and this
   * page collects it when it starts.
   */
  pendingFolder: (): Promise<string | undefined> => ipcRenderer.invoke('library:pending'),

  /**
   * Said when the Window menu has put an arrangement back.
   *
   * The menu does the work in the main process, because it has to work whether
   * or not this page exists — while a study is open it does not.
   */
  onRestored: (handler: (opened: number) => void): (() => void) => {
    const listener = (_event: unknown, opened: number): void => handler(opened);
    ipcRenderer.on('reading:restored', listener);
    return () => ipcRenderer.off('reading:restored', listener);
  },

  viewerPresent: (): Promise<boolean> => ipcRenderer.invoke('viewer:present'),

  /**
   * Whether this is an installed copy.
   *
   * What the page may suggest depends on it: an installed application has no
   * project directory and no npm, so telling somebody to run a script there is
   * an instruction they cannot follow.
   */
  installed: (): Promise<boolean> => ipcRenderer.invoke('app:installed'),

  /** What the title bar says, which is not what the document calls itself. */
  windowTitle: (): Promise<string> => ipcRenderer.invoke('window:current'),

  /** Hands this window to the viewer, at a study and a series within it. */
  openInViewer: (study: string, series?: string): Promise<void> =>
    ipcRenderer.invoke('viewer:open', study, series),

  /** Back to the worklist. */
  leaveViewer: (): Promise<void> => ipcRenderer.invoke('viewer:leave'),

  /**
   * Says what this window is showing, for the title bar and the task switcher.
   *
   * A title that always reads the product name is one nobody reads, and with
   * three reading windows open it is the only thing that tells them apart.
   */
  setTitle: (subject: string): Promise<void> => ipcRenderer.invoke('window:title', subject),

  /** The menu asked for the study to be closed. */
  onCloseStudy: (handler: () => void): (() => void) => {
    const listener = (): void => handler();
    ipcRenderer.on('library:close', listener);
    return () => ipcRenderer.off('library:close', listener);
  },

  /** The menu asked for the screens to be shown. */
  /** A folder the application was asked to open: a command line, or a second launch. */
  onOpenRequest: (handler: (folder: string) => void): (() => void) => {
    const listener = (_event: unknown, folder: string): void => handler(folder);
    ipcRenderer.on('library:open', listener);
    return () => ipcRenderer.off('library:open', listener);
  },

  onLibrary: (handler: (message: FromIndexer) => void): (() => void) => {
    const listener = (_event: unknown, message: FromIndexer): void => handler(message);
    ipcRenderer.on('library:message', listener);
    return () => ipcRenderer.off('library:message', listener);
  },

  /**
   * The path behind a dropped folder.
   *
   * A dropped File used to carry its own path, and no longer does: reading it
   * off the object was a hole, because a page could then learn where anything
   * it was handed lives on disk. Now it takes a deliberate call, and this is
   * the only place that makes it.
   */
  pathOfDropped: (file: File): string => webUtils.getPathForFile(file),

  /**
   * The product, as opposed to what it runs on.
   *
   * Taken from the packaged application rather than written here twice: a
   * version that has to be kept in step by hand is a version that will be
   * wrong.
   */
  product: {
    name: 'DICOM Workstation',
    version: __APP_VERSION__,
    author: 'Riccardo Sapuppo',
  },

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
} as const;

export type WorkstationApi = typeof api;

contextBridge.exposeInMainWorld('workstation', api);
