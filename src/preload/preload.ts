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
import { contextBridge, ipcRenderer } from 'electron';

import type { Desk } from '../main/display-topology';

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

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
} as const;

export type WorkstationApi = typeof api;

contextBridge.exposeInMainWorld('workstation', api);
