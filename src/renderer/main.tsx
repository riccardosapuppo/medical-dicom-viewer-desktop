/**
 * Starts the page. Everything else is React.
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
