/**
 * Writes the synthetic studies the demo runs on.
 *
 * There is no patient data in this repository and there never will be. What
 * ships instead is a generator: run it and get a folder that behaves like an
 * archive — two patients, a prior study to compare against, series of different
 * thickness, a scout view, and a file that is not DICOM at all, because a real
 * folder always has one.
 *
 *   npm run demo-data
 *   npm run demo-data -- ./somewhere-else
 */
import fs from 'node:fs';
import path from 'node:path';

import { axialSlice, scoutImage } from './synthetic/phantom';
import { CT_IMAGE_STORAGE, writeDicomFile, type Element } from './synthetic/write-dicom';

/** A UID root reserved for this project's synthetic data, so nothing can collide with a real archive. */
const ROOT = '1.2.826.0.1.3680043.10.1337';

interface SeriesPlan {
  number: number;
  description: string;
  sliceCount: number;
  /** Millimetres between slices. */
  sliceGap: number;
  size: number;
  scout?: boolean;
}

interface StudyPlan {
  uid: string;
  date: string;
  time: string;
  description: string;
  accession: string;
  modality: string;
  series: SeriesPlan[];
}

interface PatientPlan {
  id: string;
  name: string;
  birthDate: string;
  sex: string;
  folder: string;
  studies: StudyPlan[];
}

const PLAN: PatientPlan[] = [
  {
    id: 'DEMO-0001',
    name: 'Bianchi^Anna',
    birthDate: '19631104',
    sex: 'F',
    folder: 'bianchi-anna',
    studies: [
      {
        uid: `${ROOT}.1.1`,
        date: '20240412',
        time: '093015',
        description: 'CT CHEST WITH CONTRAST',
        accession: 'A2024-0412-31',
        modality: 'CT',
        series: [
          { number: 1, description: 'SCOUT', sliceCount: 2, sliceGap: 0, size: 256, scout: true },
          { number: 2, description: 'AXIAL 1.0MM', sliceCount: 64, sliceGap: 1, size: 256 },
          { number: 3, description: 'AXIAL 5.0MM', sliceCount: 14, sliceGap: 5, size: 256 },
        ],
      },
      {
        uid: `${ROOT}.1.2`,
        date: '20220118',
        time: '145522',
        description: 'CT CHEST',
        accession: 'A2022-0118-07',
        modality: 'CT',
        series: [{ number: 2, description: 'AXIAL 5.0MM', sliceCount: 14, sliceGap: 5, size: 256 }],
      },
    ],
  },
  {
    id: 'DEMO-0002',
    name: 'Ferrari^Luca',
    birthDate: '19780228',
    sex: 'M',
    folder: 'ferrari-luca',
    studies: [
      {
        uid: `${ROOT}.2.1`,
        date: '20240506',
        time: '171040',
        description: 'CT ABDOMEN',
        accession: 'A2024-0506-12',
        modality: 'CT',
        series: [
          { number: 1, description: 'AXIAL 2.0MM', sliceCount: 40, sliceGap: 2, size: 256 },
        ],
      },
    ],
  },
];

/** Signed 16-bit values as the bytes DICOM expects, little endian. */
function toBytes(pixels: Int16Array): Uint8Array {
  const out = new Uint8Array(pixels.length * 2);
  const view = new DataView(out.buffer);
  pixels.forEach((value, i) => view.setInt16(i * 2, value, true));
  return out;
}

function sliceElements(
  patient: PatientPlan,
  study: StudyPlan,
  series: SeriesPlan,
  seriesUid: string,
  sopUid: string,
  instanceNumber: number,
  z: number,
  pixels: Int16Array
): Element[] {
  const spacing = series.scout ? 1.5 : 350 / series.size;

  const elements: Element[] = [
    { group: 0x0008, element: 0x0016, vr: 'UI', value: CT_IMAGE_STORAGE },
    { group: 0x0008, element: 0x0018, vr: 'UI', value: sopUid },
    { group: 0x0008, element: 0x0020, vr: 'DA', value: study.date },
    { group: 0x0008, element: 0x0030, vr: 'TM', value: study.time },
    { group: 0x0008, element: 0x0050, vr: 'SH', value: study.accession },
    { group: 0x0008, element: 0x0060, vr: 'CS', value: study.modality },
    { group: 0x0008, element: 0x0070, vr: 'LO', value: 'Synthetic' },
    { group: 0x0008, element: 0x1030, vr: 'LO', value: study.description },
    { group: 0x0008, element: 0x103e, vr: 'LO', value: series.description },
    { group: 0x0010, element: 0x0010, vr: 'PN', value: patient.name },
    { group: 0x0010, element: 0x0020, vr: 'LO', value: patient.id },
    { group: 0x0010, element: 0x0030, vr: 'DA', value: patient.birthDate },
    { group: 0x0010, element: 0x0040, vr: 'CS', value: patient.sex },
    { group: 0x0018, element: 0x0050, vr: 'DS', value: series.sliceGap || 1 },
    { group: 0x0020, element: 0x000d, vr: 'UI', value: study.uid },
    { group: 0x0020, element: 0x000e, vr: 'UI', value: seriesUid },
    { group: 0x0020, element: 0x0011, vr: 'IS', value: series.number },
    { group: 0x0020, element: 0x0013, vr: 'IS', value: instanceNumber },
    { group: 0x0028, element: 0x0002, vr: 'US', value: 1 },
    { group: 0x0028, element: 0x0004, vr: 'CS', value: 'MONOCHROME2' },
    { group: 0x0028, element: 0x0010, vr: 'US', value: series.size },
    { group: 0x0028, element: 0x0011, vr: 'US', value: series.size },
    { group: 0x0028, element: 0x0030, vr: 'DS', value: [spacing, spacing] },
    { group: 0x0028, element: 0x0100, vr: 'US', value: 16 },
    { group: 0x0028, element: 0x0101, vr: 'US', value: 16 },
    { group: 0x0028, element: 0x0102, vr: 'US', value: 15 },
    // Signed, because Hounsfield units go below zero and air is -1000.
    { group: 0x0028, element: 0x0103, vr: 'US', value: 1 },
    { group: 0x0028, element: 0x1050, vr: 'DS', value: 40 },
    { group: 0x0028, element: 0x1051, vr: 'DS', value: 400 },
    { group: 0x0028, element: 0x1052, vr: 'DS', value: 0 },
    { group: 0x0028, element: 0x1053, vr: 'DS', value: 1 },
    { group: 0x7fe0, element: 0x0010, vr: 'OW', value: toBytes(pixels) },
  ];

  // A scout is a projection: it has no place in the stack, and saying it does
  // would put it in the middle of the axial series in any viewer that sorts by
  // geometry.
  if (!series.scout) {
    const half = ((series.sliceCount - 1) * series.sliceGap) / 2;
    elements.push(
      { group: 0x0020, element: 0x0032, vr: 'DS', value: [-175, -175, z - half] },
      { group: 0x0020, element: 0x0037, vr: 'DS', value: [1, 0, 0, 0, 1, 0] },
      { group: 0x0020, element: 0x1041, vr: 'DS', value: z - half }
    );
  }

  return elements;
}

/** What was written, so the caller can say so instead of this printing it. */
export interface Summary {
  files: number;
  bytes: number;
  target: string;
}

export function generate(target: string): Summary {
  let files = 0;
  let bytes = 0;

  for (const patient of PLAN) {
    for (const study of patient.studies) {
      for (const series of study.series) {
        const seriesUid = `${study.uid}.${series.number}`;
        const folder = path.join(
          target,
          patient.folder,
          `${study.date}-${study.description.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          `series-${String(series.number).padStart(2, '0')}`
        );
        fs.mkdirSync(folder, { recursive: true });

        const halfDepth = Math.max(1, ((series.sliceCount - 1) * series.sliceGap) / 2);

        for (let i = 0; i < series.sliceCount; i++) {
          const z = i * series.sliceGap;
          const pixels = series.scout
            ? scoutImage(series.size, series.size)
            : axialSlice({
                rows: series.size,
                columns: series.size,
                spacing: 350 / series.size,
                z: z - halfDepth,
                halfDepth,
              });

          const sopUid = `${seriesUid}.${i + 1}`;
          const bytesOut = writeDicomFile(
            { sopClassUid: CT_IMAGE_STORAGE, sopInstanceUid: sopUid },
            sliceElements(patient, study, series, seriesUid, sopUid, i + 1, z, pixels)
          );

          fs.writeFileSync(
            path.join(folder, `image-${String(i + 1).padStart(4, '0')}.dcm`),
            bytesOut
          );
          files++;
          bytes += bytesOut.length;
        }
      }
    }
  }

  // Every folder burned from an archive has one of these. The indexer is
  // supposed to walk past it without complaining, and this is what it walks
  // past.
  fs.writeFileSync(
    path.join(target, 'README.TXT'),
    [
      'Synthetic DICOM studies generated by dicom-workstation.',
      'No patient data. Every image is drawn from a formula.',
      '',
    ].join('\r\n')
  );

  return { files, bytes, target };
}
