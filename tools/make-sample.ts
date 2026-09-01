/**
 * The study that ships inside the application.
 *
 * Somebody who installs this and has no DICOM anywhere could previously reach
 * nothing at all: an Open folder button, a browse for thirty seconds, and quit.
 * A viewer that cannot be seen working without already owning the data is a
 * viewer nobody evaluates.
 *
 * Small on purpose — one short series, about three megabytes — because it goes
 * into every installer. It is the same phantom the tests use, so it is drawn
 * from a formula and contains no patient data of any kind.
 */
import fs from 'node:fs';
import path from 'node:path';

import { axialSlice } from './synthetic/phantom';
import { CT_IMAGE_STORAGE, writeDicomFile, type Element } from './synthetic/write-dicom';

const ROOT = '1.2.826.0.1.3680043.10.1337.99';
const SLICES = 24;
const GAP = 2;
const SIZE = 256;

export function writeSample(target: string): number {
  fs.mkdirSync(target, { recursive: true });

  const halfDepth = ((SLICES - 1) * GAP) / 2;
  let bytes = 0;

  for (let i = 0; i < SLICES; i++) {
    const z = i * GAP;
    const pixels = axialSlice({
      rows: SIZE,
      columns: SIZE,
      spacing: 350 / SIZE,
      z: z - halfDepth,
      halfDepth,
    });

    const values = new Uint8Array(pixels.length * 2);
    const view = new DataView(values.buffer);
    pixels.forEach((value, at) => view.setInt16(at * 2, value, true));

    const sop = `${ROOT}.1.${i + 1}`;
    const elements: Element[] = [
      { group: 0x0008, element: 0x0016, vr: 'UI', value: CT_IMAGE_STORAGE },
      { group: 0x0008, element: 0x0018, vr: 'UI', value: sop },
      { group: 0x0008, element: 0x0020, vr: 'DA', value: '20240412' },
      { group: 0x0008, element: 0x0030, vr: 'TM', value: '093015' },
      { group: 0x0008, element: 0x0050, vr: 'SH', value: 'SAMPLE-001' },
      { group: 0x0008, element: 0x0060, vr: 'CS', value: 'CT' },
      { group: 0x0008, element: 0x0070, vr: 'LO', value: 'Synthetic' },
      { group: 0x0008, element: 0x1030, vr: 'LO', value: 'SAMPLE CT CHEST' },
      { group: 0x0008, element: 0x103e, vr: 'LO', value: 'AXIAL 2.0MM' },
      { group: 0x0010, element: 0x0010, vr: 'PN', value: 'Sample^Study' },
      { group: 0x0010, element: 0x0020, vr: 'LO', value: 'SAMPLE-001' },
      { group: 0x0010, element: 0x0030, vr: 'DA', value: '19700101' },
      { group: 0x0010, element: 0x0040, vr: 'CS', value: 'O' },
      { group: 0x0018, element: 0x0050, vr: 'DS', value: GAP },
      { group: 0x0020, element: 0x000d, vr: 'UI', value: `${ROOT}.0` },
      { group: 0x0020, element: 0x000e, vr: 'UI', value: `${ROOT}.1` },
      { group: 0x0020, element: 0x0011, vr: 'IS', value: 1 },
      { group: 0x0020, element: 0x0013, vr: 'IS', value: i + 1 },
      { group: 0x0020, element: 0x0032, vr: 'DS', value: [-175, -175, z - halfDepth] },
      { group: 0x0020, element: 0x0037, vr: 'DS', value: [1, 0, 0, 0, 1, 0] },
      { group: 0x0028, element: 0x0002, vr: 'US', value: 1 },
      { group: 0x0028, element: 0x0004, vr: 'CS', value: 'MONOCHROME2' },
      { group: 0x0028, element: 0x0010, vr: 'US', value: SIZE },
      { group: 0x0028, element: 0x0011, vr: 'US', value: SIZE },
      { group: 0x0028, element: 0x0030, vr: 'DS', value: [350 / SIZE, 350 / SIZE] },
      { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
      { group: 0x0028, element: 0x0101, vr: 'US', value: 16 },
      { group: 0x0028, element: 0x0102, vr: 'US', value: 15 },
      { group: 0x0028, element: 0x0103, vr: 'US', value: 1 },
      { group: 0x0028, element: 0x1050, vr: 'DS', value: 40 },
      { group: 0x0028, element: 0x1051, vr: 'DS', value: 400 },
      { group: 0x0028, element: 0x1052, vr: 'DS', value: 0 },
      { group: 0x0028, element: 0x1053, vr: 'DS', value: 1 },
      { group: 0x7fe0, element: 0x0010, vr: 'OW', value: values },
    ];

    const file = writeDicomFile({ sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: sop }, elements);
    fs.writeFileSync(path.join(target, `image-${String(i + 1).padStart(4, '0')}.dcm`), file);
    bytes += file.length;
  }

  return bytes;
}
