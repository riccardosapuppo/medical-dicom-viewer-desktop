/**
 * What the preload put on the window, so the renderer can use it with types
 * instead of casts.
 */
import type { WorkstationApi } from '../preload/preload';

declare global {
  interface Window {
    workstation: WorkstationApi;
  }
}

export {};
