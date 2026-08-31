/**
 * The claim this module makes is a single sentence: the same desk always gives
 * the same fingerprint, and a different desk gives a different one. Everything
 * the workstation will remember — which window belongs on which pane — hangs off
 * that sentence being true, so it is worth pinning down before anything is
 * built on top of it.
 *
 * These run with no Electron process at all. That is why `readTopology` takes
 * `screen` as an argument instead of importing it: a desk you cannot invent is
 * a desk you can only test by owning the hardware.
 *
 *   npm test
 *   npm run mutations   (checks these tests would actually notice a break)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fingerprint, normalise, readTopology } from '../src/main/display-topology';

interface FakeDisplay {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
  internal: boolean;
  colorDepth: number;
  displayFrequency: number;
}

/** A pane of glass, described the way Electron would describe it. */
function pane(partial: Partial<FakeDisplay> & { id: number }): FakeDisplay {
  const bounds = partial.bounds ?? { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    label: '',
    workArea: bounds,
    scaleFactor: 1,
    rotation: 0,
    internal: false,
    colorDepth: 24,
    displayFrequency: 60,
    ...partial,
    bounds,
  };
}

/** A stand-in for Electron's `screen`, holding whatever desk a test needs. */
function desk(panes: FakeDisplay[], primaryId = panes[0]?.id): Electron.Screen {
  return {
    getAllDisplays: () => panes,
    getPrimaryDisplay: () => panes.find(p => p.id === primaryId) ?? panes[0],
  } as unknown as Electron.Screen;
}

// Ids as Windows actually hands them out: ten digits, unrelated to each other
// and to any ordering. Small tidy ids would have let a test that prints the id
// pass as though it printed the position — which is exactly what happened the
// first time these were written as 1, 2, 3.
const LAPTOP = 1026998383;
const READING_LEFT = 2528732444;
const READING_RIGHT = 3712004115;

/** A laptop with two portrait reporting monitors to its right. */
const READING_ROOM = [
  pane({ id: LAPTOP, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, internal: true }),
  pane({ id: READING_LEFT, bounds: { x: 1920, y: 0, width: 1200, height: 1600 }, rotation: 90 }),
  pane({ id: READING_RIGHT, bounds: { x: 3120, y: 0, width: 1200, height: 1600 }, rotation: 90 }),
];

test('the same desk fingerprints the same however the system enumerates it', () => {
  // `getAllDisplays()` promises no order, and a monitor waking late comes back
  // last. An arrangement that only matched when the panes arrived in the same
  // sequence would be a coin toss every morning.
  const forwards = fingerprint(readTopology(desk(READING_ROOM)));
  const backwards = fingerprint(readTopology(desk([...READING_ROOM].reverse(), LAPTOP)));

  assert.equal(forwards, backwards);
});

test('the ids the system hands out do not reach the fingerprint', () => {
  // These change across a reboot. If they counted, every saved layout would be
  // lost overnight — which is the bug this whole design exists to avoid.
  const renumbered = READING_ROOM.map((p, i) => pane({ ...p, id: 41 + i * 7 }));

  assert.equal(
    fingerprint(readTopology(desk(READING_ROOM))),
    fingerprint(readTopology(desk(renumbered, 41)))
  );
});

test('moving a pane changes the fingerprint', () => {
  const nudged = READING_ROOM.map(p =>
    p.id === READING_RIGHT ? pane({ ...p, bounds: { ...p.bounds, y: 200 } }) : p
  );

  assert.notEqual(
    fingerprint(readTopology(desk(READING_ROOM))),
    fingerprint(readTopology(desk(nudged)))
  );
});

test('rescaling a pane changes the fingerprint', () => {
  const rescaled = READING_ROOM.map(p => (p.id === LAPTOP ? pane({ ...p, scaleFactor: 2 }) : p));

  assert.notEqual(
    fingerprint(readTopology(desk(READING_ROOM))),
    fingerprint(readTopology(desk(rescaled)))
  );
});

test('positions are relative to the primary, not to the origin', () => {
  // Windows puts the primary at 0,0; a secondary to its left gets negative
  // coordinates, and making that one primary shifts every number on the desk
  // without a single cable being touched.
  const shifted = READING_ROOM.map(p => pane({ ...p, bounds: { ...p.bounds, x: p.bounds.x - 1920 } }));

  assert.equal(
    fingerprint(readTopology(desk(READING_ROOM))),
    fingerprint(readTopology(desk(shifted)))
  );
});

test('a smaller pane in the same place is a different desk', () => {
  // Found by breaking the module on purpose: with width and height dropped from
  // the fingerprint, every test here still passed. Two desks that differ only in
  // how big the glass is are not the same desk.
  const smaller = READING_ROOM.map(p =>
    p.id === LAPTOP ? pane({ ...p, bounds: { ...p.bounds, width: 1280, height: 720 } }) : p
  );

  assert.notEqual(
    fingerprint(readTopology(desk(READING_ROOM))),
    fingerprint(readTopology(desk(smaller)))
  );
});

test('same real pixels at a different scale is a different desk', () => {
  // Real pixels alone are not enough. 1920 points at 1x and 960 at 2x are the
  // same 1920 pixels of glass, but a window sized in points lands at half the
  // size on the second one.
  const atOne = desk([pane({ id: 5, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })]);
  const atTwo = desk([
    pane({ id: 5, bounds: { x: 0, y: 0, width: 960, height: 540 }, scaleFactor: 2 }),
  ]);

  assert.deepEqual(readTopology(atOne).panes[0]?.physical, readTopology(atTwo).panes[0]?.physical);
  assert.notEqual(fingerprint(readTopology(atOne)), fingerprint(readTopology(atTwo)));
});

test('the laptop screen and an identical external one are not interchangeable', () => {
  // Docked and undocked are different desks even when the numbers agree: the
  // arrangement saved with the lid open is not the one to restore when it is
  // closed and a monitor of the same size has taken its place.
  const builtIn = desk([pane({ id: 5, internal: true })]);
  const external = desk([pane({ id: 5, internal: false })]);

  assert.notEqual(fingerprint(readTopology(builtIn)), fingerprint(readTopology(external)));
});

test('a single laptop screen is a desk like any other', () => {
  const topology = readTopology(desk([pane({ id: 7, scaleFactor: 1.25, internal: true })]));

  assert.equal(topology.panes.length, 1);
  assert.equal(topology.panes[0]?.isPrimary, true);
  assert.deepEqual(topology.panes[0]?.physical, { width: 2400, height: 1350 });
  assert.match(fingerprint(topology), /^[0-9a-f]{12}$/);
});

test('an unlabelled pane is named by its place, never by its id', () => {
  // Windows reports no label. Printing the id instead would put the one number
  // this module refuses to trust into the one line a person reads.
  const topology = readTopology(desk(READING_ROOM));

  assert.deepEqual(
    topology.panes.map(p => p.label),
    ['Screen 1', 'Screen 2', 'Screen 3']
  );
});

test('normalising sorts left to right regardless of arrival order', () => {
  const normalised = normalise(readTopology(desk([...READING_ROOM].reverse(), LAPTOP)));

  assert.deepEqual(
    normalised.map(p => p.x),
    [0, 1920, 3120]
  );
});
