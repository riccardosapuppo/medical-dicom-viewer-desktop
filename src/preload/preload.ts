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
  openOnScreen: (seriesInstanceUid: string, pane: number): Promise<void> =>
    ipcRenderer.invoke('reading:open', seriesInstanceUid, pane),

  closeReading: (seriesInstanceUid: string): Promise<void> =>
    ipcRenderer.invoke('reading:close', seriesInstanceUid),

  /** Which screen this desk last had this series on, if any. */
  recallScreen: (seriesInstanceUid: string): Promise<number | undefined> =>
    ipcRenderer.invoke('reading:recall', seriesInstanceUid),

  /** Reopens the arrangement this desk remembers. Resolves to how many windows opened. */
  restoreArrangement: (): Promise<number> => ipcRenderer.invoke('reading:restore'),

  /** Opens the file chooser. Resolves to the folder the chosen files are in. */
  chooseFiles: (): Promise<string | undefined> => ipcRenderer.invoke('library:chooseFiles'),

  /** The folders opened before, newest first. */
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('library:recent'),

  /** Where the study that ships inside the application lives. */
  sampleFolder: (): Promise<string> => ipcRenderer.invoke('library:sample'),

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
  onShowScreens: (handler: () => void): (() => void) => {
    const listener = (): void => handler();
    ipcRenderer.on('view:screens', listener);
    return () => ipcRenderer.off('view:screens', listener);
  },

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
