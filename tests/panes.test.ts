/**
 * Where a reading window lands on a pane.
 *
 * Every desk here is one this machine does not have, which is the point: a
 * monitor to the left of the primary sits at negative coordinates, a taskbar
 * can be down the side rather than along the bottom, and a portrait monitor is
 * taller than it is wide. All three are ordinary in a reading room and none of
 * them can be tried out without owning the hardware.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pane } from '../src/main/display-topology';
import { boundsForPane } from '../src/main/layout/panes';

function pane(bounds: Pane['bounds'], workArea?: Pane['workArea']): Pane {
  return {
    id: 1026998383,
    label: 'Screen 1',
    bounds,
    workArea: workArea ?? bounds,
    scaleFactor: 1,
    rotation: 0,
    internal: false,
    colorDepth: 24,
    displayFrequency: 60,
    physical: { width: bounds.width, height: bounds.height },
    offsetFromPrimary: { x: bounds.x, y: bounds.y },
    isPrimary: true,
  };
}

test('a window fills the pane it is sent to', () => {
  const bounds = boundsForPane(pane({ x: 0, y: 0, width: 1920, height: 1080 }));

  assert.deepEqual(bounds, { x: 1, y: 1, width: 1918, height: 1078 });
});

test('the space the system keeps is left alone', () => {
  // A window sized to the whole screen covers the taskbar, and a window
  // covering the taskbar is one somebody cannot get out from behind.
  const bounds = boundsForPane(
    pane({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1032 })
  );

  assert.equal(bounds.height, 1030);
});

test('a taskbar down the side is not assumed to be along the bottom', () => {
  // A fixed inset at the bottom would be right on one desk and wrong here.
  const bounds = boundsForPane(
    pane({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 72, y: 0, width: 1848, height: 1080 })
  );

  assert.equal(bounds.x, 73);
  assert.equal(bounds.width, 1846);
  assert.equal(bounds.height, 1078);
});

test('a screen to the left of the primary keeps its negative coordinates', () => {
  // Windows puts the primary at 0,0 and everything to its left below zero. A
  // placement that clamps to zero stacks the second window on top of the first.
  const bounds = boundsForPane(pane({ x: -1200, y: -140, width: 1200, height: 1600 }));

  assert.equal(bounds.x, -1199);
  assert.equal(bounds.y, -139);
  assert.equal(bounds.width, 1198);
  assert.equal(bounds.height, 1598);
});

test('a portrait monitor is taller than it is wide, and stays that way', () => {
  const bounds = boundsForPane(pane({ x: 1920, y: 0, width: 1200, height: 1600 }));

  assert.ok(bounds.height > bounds.width);
});

test('a pane too small to hold a window still gets a usable one', () => {
  // A projector at 640x480, or a work area a shell has reported wrongly. A
  // window of nothing is a window nobody can find to close.
  const bounds = boundsForPane(pane({ x: 0, y: 0, width: 200, height: 100 }));

  assert.ok(bounds.width >= 320);
  assert.ok(bounds.height >= 240);
});
