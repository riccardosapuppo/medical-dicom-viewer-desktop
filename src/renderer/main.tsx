/**
 * Starts the page. Everything else is React.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ReadingWindow } from './ReadingWindow';

const container = document.getElementById('root');

if (!container) {
  // The page is a file this repository ships, so a missing root is a build
  // that went wrong, not a condition to recover from. Say which.
  throw new Error('index.html has no #root: the renderer bundle and the page are out of step.');
}

/**
 * Which of the two things this window is.
 *
 * A window opened on a reading monitor is told what it shows through the
 * address: #reading/<series uid>. It carries no folder and no worklist, and it
 * needs nothing from the main process before it can start.
 */
const PREFIX = '#reading/';
const hash = window.location.hash;
const reading = hash.startsWith(PREFIX) ? decodeURIComponent(hash.slice(PREFIX.length)) : undefined;

createRoot(container).render(
  <React.StrictMode>
    {reading ? <ReadingWindow seriesInstanceUid={reading} /> : <App />}
  </React.StrictMode>
);
