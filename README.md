# DICOM Workstation

A desktop reading workstation: native windows placed on the panes of glass they
belong to, arrangements that come back the next morning, and studies read
straight off the disk.

It opens any DICOM study whose pixel data is uncompressed and greyscale — CT,
MR, computed and digital radiography, and anything else stored that way.
Nothing here decides by modality. What it will not open is stated at the bottom,
and it is about how the pixels are stored, not about what was scanned.

The original was built for a client and lives in a private repository. This is
an independent reimplementation, written from scratch with synthetic data.

## Where it is

A folder of studies opens, reads into a worklist, a series opens onto an image
you can scroll, window, zoom, pan and measure, reformat into the coronal and
sagittal planes, and send to a screen of its own — where the desk remembers it.

```
npm install
npm run demo-data          # writes ~17 MB of synthetic studies into ./demo-data
npm start                  # builds and opens the window
npm start -- --open ./demo-data
npm run index -- ./demo-data   # the same reading, in the terminal, no window
npm run displays           # what screens are attached, and this desk's fingerprint
npm test
npm run check:ui           # drives the built application and reads the canvas back
npm run mutations          # breaks the code on purpose, checks the tests notice
npm run package            # an installer for the system you are on
npm run check:packaged     # the same interface checks, against the packaged build
```

![A series open](docs/viewer.png)

Drag to window, wheel to scroll the stack, middle to pan, right to zoom,
double click to reset — the mapping every reporting workstation uses. Matching
it is not imitation: somebody who reads all day has it in their hands, and a
viewer that puts zoom on the left button gets the window changed by accident on
the first study. Arrow keys, page up and down, home and end do the same thing,
because a viewer reachable only by dragging is one that some people cannot use.

## Screens, and a desk that remembers

Hovering a series in the worklist shows one small button per screen. Pressing
one opens that series in a window of its own on that pane of glass: no
worklist, no folder, nothing but the image, because that is what a reporting
monitor is for.

![The worklist](docs/library.png)

Where each series was put is written down against the desk fingerprint, and
**Restore arrangement** brings the windows back. Keyed on the fingerprint
rather than on screen ids for the reason the fingerprint exists: a radiologist
who docks their laptop in the morning gets the arrangement they left, and the
same person working from the laptop alone gets a different desk and a
different arrangement — which is correct, not a failure to remember.

A placement on a screen that is no longer attached is never used. The
arrangement was made on a bigger desk, and a window opened at coordinates
nobody can see is worse than a window that did not open.

Windows are placed inside a pane’s work area rather than over the whole of
it, and one pixel in on each side. A window covering the taskbar is one
somebody cannot get out from behind, and a window exactly the size of the work
area is treated by Windows as maximised and loses its border, which makes two
adjacent reading windows impossible to tell apart.

None of this has met real hardware. This machine has one screen, so `check:ui`
exercises the whole path and not the placement, and the placement itself — a
monitor left of the primary and therefore at negative coordinates, a portrait
pair, a taskbar down one side — is covered by tests against invented desks.
Inventing one is the only way to test a desk nobody owns, and it is not the
same as owning it.

## Reformatting

A CT is acquired one axial slice at a time and stored that way, but a body is
read along as well as across. **Coronal** and **sagittal** are not stored
anywhere: they are cut out of the stack, treating it as the solid it came from.

![A coronal reformat](docs/reformat.png)

Which is only legitimate when the stack really is a solid, and plenty of series
are not. A scout view is two projections at the same place. A localiser is
three orthogonal images in one series. A study reconstructed in two blocks has
a gap in the middle. Reformatting any of them produces a picture that looks
like anatomy and is not — which is worse than refusing — so most of that module
is about refusing, with the reason shown under the image: not evenly spaced,
not all the same size, no position in the patient, too large to hold in memory.

The spacing between slices comes from the geometry, not from `SliceThickness`.
A study can be reconstructed one millimetre thick every five millimetres, and
the two numbers mean different things; using the wrong one shows a body the
wrong length. The reformatted planes then have rectangular pixels — the demo
stack is 1.37 mm across and 1 mm along — and the interface check measures the
shape the anatomy is drawn at rather than looking at it, because a reformat
drawn at the wrong spacing is a picture of the right thing at the wrong shape,
and it looks entirely plausible.

The volume is built the first time a reformat is asked for, not when the series
opens: it means reading every image, and most of the time nobody asks. The
stack is walked from the top down so the most superior slice ends up at the top
of the picture, and each cut carries the sign and the rescale of the values,
so a coronal region still measures in Hounsfield units.

## Measuring

Two tools, which between them are most of what gets drawn on a diagnostic
image: a length, and an elliptical region with statistics. Both report in the
units the file measures in — millimetres, and Hounsfield units on a CT —
because a length in pixels and a density in stored numbers are values nobody
can put in a report.

A length is measured across and down separately, because pixel spacing is two
numbers and they are not always the same. Using one of them for both is right
on square pixels and wrong by an amount too small to notice and too large to
accept on everything else.

A region is the ellipse inscribed in the box that was dragged, not the box:
the corners of the box are a fifth of its area and they are usually somewhere
else entirely. Pixels are tested at their centres, the deviation is the
population one over the pixels included rather than a sample estimate, and a
region dragged off the edge measures the part of it that is over pixels rather
than reading whatever is next in memory.

Only a CT number gets a unit. An MR number is a signal intensity whose scale
depends on the sequence and the coil, and calling it anything would be
inventing a unit.

The annotations are drawn on a canvas of their own, over the image. Keeping
them apart means vector work is not re-rasterised on every window drag, and it
means anything reading the image back — including this project’s own interface
check — is not reading its own ink.

Where the image sits on the canvas is worked out in one module used by both
the shader and the annotations. Two answers to that question agree until
somebody changes one of them, and a measurement a few pixels off the thing it
measures is the kind of wrong that gets believed.

## Drawing the image

The stored numbers go to the graphics card untouched, as an integer texture,
and the sign correction, the rescale and the window are done in the fragment
shader. Not an optimisation for its own sake: windowing on the processor means
rebuilding a quarter of a million pixels every time the mouse moves one pixel,
and window and level are dragged continuously. On the card it is one uniform.

Sampling is nearest, always. An integer texture cannot be filtered at all in
WebGL2, and that turns out to be the right constraint: interpolation invents
pixel values that were never measured, and a number someone reports on should
be one the scanner produced.

The window arithmetic is the linear VOI transformation from PS3.3 C.11.2.1.2,
half-unit offsets included. They look like rounding noise. On a bone window
fifteen hundred units wide, dropping them is invisible; on a brain window
eighty units wide it is most of a grey level, so the test that guards them
asserts an exact value rather than "about a half" — which is exactly what the
broken version also gives.

Frames arrive one at a time over the `dicom:` scheme, described below. The
viewer keeps a bounded number of them and asks ahead in the direction of
travel: somebody scrolling down wants the next slice, and a symmetric prefetch
spends half its work behind them.

## The `dicom:` scheme

The page needs the bytes of a frame and must not be given the disk to find them
with. So it asks for an image by the name the standard already gives it:

```
dicom://instance/<sop-instance-uid>/frames/<n>
```

and the main process answers only for images in the folder that is currently
open. A path is not something the page can express at all, and a UID that was
never indexed comes back as 404 rather than as a refusal — saying "forbidden"
would tell the page that the image exists somewhere, which is more than it is
entitled to know. Opening another folder replaces what can be asked for; there
is no moment at which a viewer holds a handle on a folder the user has closed.

Range requests are answered properly, with 206 and a `Content-Range`. A partial
request that is silently given the whole body is worse than one that fails: the
caller gets bytes at the wrong offset and draws noise without knowing it. A
range past the end of a frame is refused rather than clamped, because the byte
after the last one of frame 1 is the first one of frame 2.
## Where the reading happens

Not in the window, and not in the page.

A thousand headers is a thousand file opens and a thousand parses. In the main
process that blocks the event loop and the window stops repainting — the
application looks hung at exactly the moment it is working hardest. In the
renderer it would mean handing a page the file system, which is the one thing
a viewer that renders whatever a study contains should not have.

So it happens in a utility process: Node, with the disk, and no window. It
reports progress once per percent rather than once per file, because on a fast
disk the messages cost more than the reading. Picking a second folder while the
first is still going aborts it — finishing would send back a list for a folder
nobody is looking at any more. If the process dies mid-folder the window is told
which folder was lost, instead of watching a progress bar that will never move
again.

![The desk](docs/desk.png)

With no folder open the window shows the desk it is standing on, drawn to
scale. That is not a placeholder: everything this application will do is place
windows on those panes and put them back where they were, and being able to see
the arrangement it believes in is what makes that debuggable rather than magic.
It redraws when a monitor is plugged, unplugged or rescaled — and only when the
fingerprint actually moves, since the same event also fires for a colour profile
change, which moves no window.
## Reading a folder

`npm run index -- ./demo-data` walks a folder, reads every DICOM header it
finds, and prints the reading list:

```
Bianchi Anna   DEMO-0001
  2024-04-12  CT CHEST WITH CONTRAST   CT   80 images   acc A2024-0412-31
      1. SCOUT                           2 img  256x256    0.3 MB  ordered by number
      2. AXIAL 1.0MM                    64 img  256x256    8.1 MB  ordered by position
      3. AXIAL 5.0MM                    14 img  256x256    1.8 MB  ordered by position
  2022-01-18  CT CHEST   CT   14 images   acc A2022-0118-07
      2. AXIAL 5.0MM                    14 img  256x256    1.8 MB  ordered by position

134 images read, 1 files skipped as not DICOM in 64 ms
```

Three decisions in there are worth stating.

**The pixels are never read.** A chest CT is a few hundred files of half a
megabyte each, and indexing them means opening every one. The reader takes a
chunk off the front and parses until the pixel data element, so a study of any
size costs a few hundred bytes per image instead of half a megabyte. The chunk
size is a guess, and a guess about DICOM headers is always wrong somewhere, so
the guess is allowed to be wrong: run off the end and it reads more.

**Slices are ordered by geometry, not by number.** InstanceNumber is a label.
Scanners number series backwards relative to the direction of travel, some do
not number them at all, and a series merged from two acquisitions can repeat
numbers outright. What is reliable is that each slice carries its own corner in
patient coordinates and the series carries the plane it was cut on: project one
onto the normal of the other and you have a real distance along the stack. The
listing says which key each series was sorted by, because a stack ordered by
number is a stack that might be upside down.

**A folder from a CD is a mess, and that is not an error.** Autorun files,
readmes, thumbnails and the viewer that came on the disc are counted and passed
over. A file that claims to be DICOM and will not parse is a different thing
entirely — that is a missing slice — so it is reported by name.

## Why a fingerprint, and not the screen id

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
`npm run mutations` removes one thing the code is meant to guarantee, runs the
suite, and reports any mutation the tests slept through.

It earned its place the first time it ran: four of six mutations survived. The
desk fingerprint could quietly lose pane size, scaling, and built-in-versus-
external without a single red line, and the test on screen labels was being
defeated by its own fixture, whose fake ids happened to be 1, 2 and 3 — the
very ordinals it was written to tell them apart from.

It has since caught two more of the same kind. A test that a text file is
skipped rather than reported as corrupt was passing on a 34-byte fixture, which
never got past the length check to reach the check being tested. And a test that
an unnumbered slice sorts last was passing against a deliberately broken
comparison, because with three elements the sort happens to come out right
anyway.

## Looking at what was actually drawn

`npm run check:ui` opens the built application on the demo folder, clicks the
largest series, and reads the pixels back off the canvas. Unit tests cannot say
that an image reached the screen: a shader that fails to compile, a texture
uploaded in the wrong format, a canvas sized to nothing and a window that is
entirely black all pass every other test here.

It checks that a quarter of the canvas is not black, that there is a range of
greys rather than one flat tone, that scrolling produces a genuinely different
picture, that dragging changes the window and the picture with it, that a preset
lands on exactly the numbers it names, that a series opens in a window of its own
and the desk remembers it, that the keyboard moves through the stack, and that
measurements are drawn — and that a click without a drag leaves none.

Four things it taught, each of which had produced a check that lied.

It reported a uniformly black screen while the application was plainly
drawing. With `preserveDrawingBuffer` off the buffer is cleared as soon as it
has been composited, so anything reading it in a later task reads zeros. The
measurement was wrong, not the drawing. The buffer is kept now — which is also
what exporting the image somebody is looking at will need.

Its first test for "a different slice looks different" compared mean
brightness, which is far too blunt: the difference between neighbouring slices
is a couple of per cent of a couple of per cent of the frame. It compares a
hash of the greys now, and breaking the texture upload on purpose confirms it
notices.

Two of its readings depended on when a frame happened to be drawn, so they
passed or failed with how busy the machine was. They read until two readings
agree now. An unstable check is worse than no check, because it teaches you to
ignore it.

And one line of it could only ever pass — it compared a value with itself. It
compares the image before the annotations were drawn with the image after,
which is the property it was supposed to be testing.

The suite it runs against is checked too: `npm run mutations` refuses to start
if any test is already failing, because against a red suite every mutation
looks caught and the report comes out perfect while proving nothing.
## Installing it

```
npm run package        # an installer for the system you are on
npm run package:dir    # the same application, unpacked, without an installer
npm run check:packaged # the interface checks, driven against the packaged build
```

On Windows that produces an 81 MB installer that installs per user and needs
no administrator: a reading room installs software on machines it does not
administer, and an installer that demands elevation is one that does not get
run. macOS gets a disk image and Linux an AppImage, from the same
configuration.

`check:packaged` runs every one of the interface checks against the built
application rather than against the development one. That is where packaging
mistakes live and nowhere else — a renderer left out of the archive, a path
that worked relative to the project and does not relative to an installed
application, a file the build configuration quietly excluded. Every one of
them looks perfect in development and gives a blank window to whoever installs
it.

The icon is drawn by `npm run icon`, in about fifty lines and with nothing but
zlib. The alternative was a binary in the repository that nobody can see the
provenance of, or an image library in a project that has no other use for one.

### Signing and updates, honestly

Neither is done, and the configuration says where they would go.

Code signing needs a certificate that belongs to a person or a company, is
bought rather than configured, and cannot be checked into a repository. The
build is complete up to that point and produces an unsigned application, which
Windows will warn about on first run and macOS will refuse to open without
being told to.

The update feed is configured — provider, owner, repository — and nothing is
published to it. An installed copy would look for a newer one at that address
and find nothing there. The address is written down because it is part of the
design, not because a release exists.

## What an adversarial reading found

Twelve readers were set on this code with instructions to break it, each one
given a different thing to look for, and every claim they made was handed to a
second reader whose job was to refute it. Fifty-four claims: thirty-two were
wrong, twenty-two survived. Every one of the twenty-two is fixed, and each has
a test and an entry in the mutation harness.

The two worth naming, because both were silent:

**A header could be read short without anything raising.** The parser walks
elements until the buffer runs out. When it runs out in the middle of one it
raises, and the reader reads more — which is what the growth loop was written
for and what the tests covered. When it runs out exactly *between* two
elements it stops cleanly and hands back what it has, and what is missing is
the tags at the end, which is where the pixel data is. The image listed
correctly and could never be opened. It now reads more until it has actually
reached the pixel data, because arriving there is the only proof there was
nothing after it.

**Images with no identifier were counted as copies of each other.** A missing
SOP Instance UID reads as an empty string, and deduplication keyed on it: five
anonymised slices became one, and the other four were reported as duplicates —
a false statement about four images that had simply gone. Anonymisers blank
that tag rather than removing it, so this is not a corner case.

The rest were of the same family: progress from a folder the user had already
left driving the new folder’s bar, a frame past the end of the pixel data
answered with a length the body could not fill, a lowercase `dicomdir` indexed
as a phantom study, an index that came out differently on two runs over one
unchanged folder because eight readers finished in whatever order the disk
answered in, a pan that followed two thirds of the pointer on a scaled screen,
a focus ring drawn on an element with no box to draw it on, and four tests that
could not fail.

## No patient data

There is none in this repository and there never will be. `npm run demo-data`
writes the studies the demo runs on: two patients, a prior study to compare
against, series of different slice thickness, a scout view, and a readme file
that is not DICOM, because a real folder always has one. Every image is drawn
from a formula — a sphere inside a cylinder, in Hounsfield units, with ribs and
one inclusion to find.

## Limits, honestly

- One image per window. No side-by-side layouts inside a window, and no linked
  scrolling between windows.
- Reformatting is orthogonal only: coronal and sagittal, cut at whole voxels.
  No oblique planes, no slab thickness, no interpolation between slices, and no
  volume rendering.
- Measurements live for as long as the window does. They are not saved with the
  study, not exported, and cannot be moved or removed one at a time — the whole
  set on an image is cleared at once.
- A series sent to a screen opens where the desk remembers it; the main window
  itself is not placed or remembered, and always opens on the primary.
- Windows already open are not re-placed when a monitor is unplugged
  mid-session. The system moves them somewhere visible and the new desk gets
  its own arrangement from then on.
- Verified on Windows 11 against a single built-in screen. Every multi-monitor
  case here — a screen to the left of the primary and so at negative
  coordinates, a portrait pair, a taskbar taking space off one edge — is
  covered by tests against invented desks, because inventing one is the only
  way to test it without owning it. None of it has met real hardware.
- Explicit and implicit VR little endian are read, and both are covered by
  tests. Big endian is not handled. Compressed transfer syntaxes read their
  headers fine, which is all the index needs, and asking for a frame comes back
  as 415 naming the syntax that was found: nothing decodes JPEG, JPEG 2000 or
  RLE.
- Greyscale only. An ultrasound or a doppler image stored as colour is listed
  correctly and cannot be displayed: the shader reads one sample per pixel. This
  is a limit of how the pixels are stored, not of the modality — a monochrome
  ultrasound opens like anything else.
- Files without the 128-byte preamble and `DICM` marker are treated as not
  DICOM. Raw datasets written without a Part 10 wrapper will be skipped.
- `physical` is `bounds x scaleFactor` — the panel's real pixel count as the
  system reports it, which is not the same as its advertised specification.
- If `ELECTRON_RUN_AS_NODE` is set in your shell, Electron starts as plain Node
  and no Electron API exists. `npm run displays` says so and stops.
