/**
 * The desk drawn for arrangements this machine does not have.
 *
 * Everything else about the map can be judged by looking at it. The multi-
 * monitor cases cannot, not without the monitors, and those are exactly the
 * ones that go wrong: a secondary screen to the left of the primary has
 * negative coordinates, and a viewBox that assumes the desk starts at the
 * origin puts it off the edge of the drawing where nobody sees it.
 *
 * Rendered to a string, so no browser is involved and the numbers can be read
 * off directly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Desk, Pane } from '../src/main/display-topology';
import { DeskMap } from '../src/renderer/DeskMap';

function pane(partial: Partial<Pane> & { id: number; bounds: Pane['bounds'] }): Pane {
  return {
    label: `Screen ${partial.id}`,
    workArea: partial.bounds,
    scaleFactor: 1,
    rotation: 0,
    internal: false,
    colorDepth: 24,
    displayFrequency: 60,
    physical: { width: partial.bounds.width, height: partial.bounds.height },
    offsetFromPrimary: { x: partial.bounds.x, y: partial.bounds.y },
    isPrimary: false,
    ...partial,
  };
}

function desk(panes: Pane[]): Desk {
  return { panes, primaryId: panes[0]?.id ?? 0, fingerprint: 'aaaaaaaaaaaa' };
}

/** The viewBox as four numbers. */
function viewBox(markup: string): number[] {
  const raw = /viewBox="([^"]+)"/.exec(markup)?.[1] ?? '';
  return raw.split(' ').map(Number);
}

test('a screen to the left of the primary is inside the drawing', () => {
  // Windows puts the primary at 0,0 and gives everything to its left negative
  // coordinates. A viewBox starting at 0 would draw this one off the canvas.
  const markup = renderToStaticMarkup(
    <DeskMap
      desk={desk([
        pane({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true }),
        pane({ id: 2, bounds: { x: -1200, y: -200, width: 1200, height: 1600 } }),
      ])}
    />
  );

  const [x, y, width, height] = viewBox(markup);

  assert.ok((x as number) <= -1200, `the box starts at ${x}, left of the leftmost screen`);
  assert.ok((y as number) <= -200);
  assert.ok((x as number) + (width as number) >= 1920);
  assert.ok((y as number) + (height as number) >= 1400);
});

test('every screen is drawn, and only the primary is marked', () => {
  const markup = renderToStaticMarkup(
    <DeskMap
      desk={desk([
        pane({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
        pane({ id: 2, bounds: { x: 1920, y: 0, width: 1200, height: 1600 }, isPrimary: true }),
        pane({ id: 3, bounds: { x: 3120, y: 0, width: 1200, height: 1600 } }),
      ])}
    />
  );

  assert.equal(markup.match(/class="pane__glass"/g)?.length, 3);
  assert.equal(markup.match(/class="pane pane--primary"/g)?.length, 1);
  assert.equal(markup.match(/class="pane"/g)?.length, 2);
});

test('the work area is drawn where the system says, not inset by guesswork', () => {
  // The taskbar takes 48 points off the bottom here. Drawing the work area as
  // a fixed inset would be right on this desk and wrong on a dock at the side.
  const markup = renderToStaticMarkup(
    <DeskMap
      desk={desk([
        pane({
          id: 1,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1032 },
          isPrimary: true,
        }),
      ])}
    />
  );

  assert.match(markup, /class="pane__work-area"[^>]*height="1032"/);
});

test('a single screen still gets a box with room around it', () => {
  const markup = renderToStaticMarkup(
    <DeskMap desk={desk([pane({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true })])} />
  );

  const [x, y, width, height] = viewBox(markup);

  assert.ok((x as number) < 0 && (y as number) < 0, 'padding on the top and left');
  assert.ok((width as number) > 1920 && (height as number) > 1080);
});
