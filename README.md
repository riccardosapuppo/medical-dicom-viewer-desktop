# DICOM Workstation

A desktop reading workstation for CT and MR studies: native windows placed on
the panes of glass they belong to, arrangements that come back the next
morning, and studies read straight off the disk.

The original was built for a client and lives in a private repository. This is
an independent reimplementation, written from scratch with synthetic data.

## Where it is

Early. What exists so far is the foundation everything else stands on: reading
the desk, and being able to recognise the same desk again.

```
npm install
npm run displays          # what screens are attached, and this desk's fingerprint
npm run displays -- --json
npm test
npm run mutations         # breaks the module on purpose, checks the tests notice
```

`npm run displays` opens no window. It prints one block per screen and a short
digest of the arrangement:

```
Screen 1  (primary, built-in)
  1920x1200 real pixels   scale 1.25x   1536x960 points
  at 0,0 from the primary   rotation 0deg   60 Hz   24 bit
  usable 1536x912 at 0,0  (the system keeps the rest)

Desk fingerprint: b60acb6761b2
```

## Why the fingerprint, and not the screen id

The operating system hands out an id for every display, and it is the obvious
key for remembering where a radiologist put their windows. It is also the wrong
one: those ids do not survive a reboot, a cable moved to another port, or a
monitor waking in a different order. A layout saved against them comes back
attached to the wrong glass, or to none.

What does survive is the shape of the desk — how many panes, how big in real
pixels, at what scaling and rotation, and where each sits relative to the
primary. The fingerprint is a digest of exactly that, with ids, labels and
enumeration order deliberately thrown away first.

## The mutation check

`npm test` says the tests ran. It does not say they would catch anything.
`npm run mutations` removes one thing the fingerprint is meant to depend on,
runs the suite, and reports any mutation the tests slept through.

It earned its place the first time it ran: four of six mutations survived. The
fingerprint could quietly lose pane size, scaling, and built-in-versus-external
without a single red line, and the test on screen labels was being defeated by
its own fixture, whose fake ids happened to be 1, 2 and 3 — the very ordinals
it was written to tell them apart from.

## Limits, honestly

- Only the display reading exists. No viewer, no windows, no DICOM yet.
- Verified on Windows 11 against a single built-in screen. The multi-monitor
  behaviour is covered by tests with invented desks, not by hardware.
- `physical` is `bounds x scaleFactor` — the panel's real pixel count as the
  system reports it, which is not the same as its advertised specification.
- If `ELECTRON_RUN_AS_NODE` is set in your shell, Electron starts as plain Node
  and no Electron API exists. The command says so and stops.
