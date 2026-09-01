/**
 * Starts the page. Everything else is React.
 *
 * This page is the part of the application that is about the machine: choosing
 * a folder, seeing what is in it, and deciding which screen a series goes on.
 * Reading a study is the viewer's job, and a window doing that is showing the
 * viewer rather than this page.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const container = document.getElementById('root');

if (!container) {
  // The page is a file this repository ships, so a missing root is a build
  // that went wrong, not a condition to recover from. Say which.
  throw new Error('index.html has no #root: the renderer bundle and the page are out of step.');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
