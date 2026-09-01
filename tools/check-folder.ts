#!/usr/bin/env node
/**
 * Says whether this application can actually read a folder of studies.
 *
 *   npm run check:folder -- "D:\\studies\\a patient"
 *
 * It exists because of a specific failure. Every check written before it drove
 * the same five studies, downloaded from one public archive, all of them stored
 * uncompressed — and they passed while a real folder from a real scanner opened
 * onto "these images could not be read". The application was checked against
 * the data it was built with, which is not a check at all.
 *
 * So this takes any folder, indexes it exactly as the application does, and then
 * asks the archive for the first frame of every series through exactly the code
 * that serves the viewer. What comes back is either an image or the reason there
 * is not one, printed next to the transfer syntax that produced it — which is
 * the fact that decides everything and the one nobody can see.
 *
 * Nothing is written and nothing leaves the machine. The files are only read.
 */
import path from 'node:path';

import { indexFolder } from '../src/main/dicom/index-folder';
import { givenPath } from './given-path';
import type { Series, Study } from '../src/main/dicom/build-index';
import { isProblem, readFrame } from '../src/main/dicomweb/frames';
import { readInstance } from '../src/main/dicomweb/metadata';

const WADO = 'http://127.0.0.1:0/dicom-web';

/** The names transfer syntax UIDs go by, for the ones that turn up. */
const SYNTAXES: Record<string, string> = {
  '1.2.840.10008.1.2': 'implicit VR little endian',
  '1.2.840.10008.1.2.1': 'explicit VR little endian',
  '1.2.840.10008.1.2.1.99': 'deflated explicit VR',
  '1.2.840.10008.1.2.2': 'explicit VR BIG endian',
  '1.2.840.10008.1.2.4.50': 'JPEG baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG extended',
  '1.2.840.10008.1.2.4.57': 'JPEG lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG lossless, first-order prediction',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS near-lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE',
};

function named(uid: string): string {
  return SYNTAXES[uid] ? `${SYNTAXES[uid]}` : uid || 'not stated';
}

const asked = givenPath(process.argv[2] ?? '');
const where = asked.folder;

if (!where) {
  process.stderr.write('Give a folder:  npm run check:folder -- "D:\\\\studies"\n');
  process.exit(1);
}

/** One line per series, saying whether the viewer would get an image. */
function checkSeries(study: Study, series: Series): boolean {
  const first = series.instances[0];
  const name = series.description || 'unnamed series';

  if (!first) {
    console.log(`  --    ${name}   empty`);
    return true;
  }

  if (series.holds) {
    // Not a picture, and not a failure. A study carries objects that say how an
    // image should be shown or what was found in it, and they hold no pixels.
    console.log(`  --    ${name}   ${series.instances.length} object(s), ${series.holds}`);
    return true;
  }

  const syntax = named(first.pixels.transferSyntaxUid);
  const shape =
    `${first.pixels.columns ?? '?'}x${first.pixels.rows ?? '?'}, ` +
    `${first.pixels.bitsAllocated ?? '?'}-bit, ` +
    `${first.pixels.numberOfFrames} frame(s)`;

  // Exactly what the archive does when the viewer asks for the first frame.
  const frame = readFrame(first.filePath, first.pixels, 1);

  if (isProblem(frame)) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${syntax}, ${shape}`);
    console.log(`        ${frame.reason}`);
    console.log(`        ${path.basename(first.filePath)}`);
    return false;
  }

  // And what it does when the viewer asks what the image is.
  const described = readInstance(first.filePath, WADO);

  if (!described) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${syntax}, ${shape}`);
    console.log('        the header could not be read as metadata');
    return false;
  }

  console.log(
    `  ok    ${name}` +
      `   ${series.instances.length} img, ${syntax}, ${shape}, ` +
      `frame ${(frame.bytes.length / 1024).toFixed(0)} KB as ${frame.mediaType}`
  );
  void study;
  return true;
}

async function main(): Promise<void> {
  console.log(`Reading ${path.resolve(where)}`);

  if (asked.corrected) {
    // Said rather than quietly corrected: the same doubling will happen to
    // every other command given the same folder.
    console.log(
      'The caret in that name was doubled on the way through npm and cmd.\n' +
        'Read as the folder that is actually there.'
    );
  }

  console.log('');

  const { index, found, read, skipped, unreadable, elapsedMs } = await indexFolder(where);

  console.log(
    `${read} of ${found} files read in ${Math.round(elapsedMs)} ms` +
      (skipped ? `, ${skipped} not DICOM` : '') +
      (unreadable.length ? `, ${unreadable.length} would not parse` : '') +
      '\n'
  );

  for (const file of unreadable.slice(0, 5)) {
    console.log(`  unreadable: ${path.basename(file.filePath)} — ${file.reason}`);
  }
  if (unreadable.length > 5) {
    console.log(`  ... and ${unreadable.length - 5} more that would not parse`);
  }
  if (unreadable.length) {
    console.log('');
  }

  let ok = 0;
  let bad = 0;

  for (const patient of index.patients) {
    for (const study of patient.studies) {
      console.log(
        `${patient.name || `Anonymized — ${patient.patientId}`}  ` +
          `${study.studyDate || 'undated'}  ${study.description || 'no description'}  ` +
          `${study.modalities.join(' ')}`
      );

      for (const series of study.series) {
        if (checkSeries(study, series)) {
          ok++;
        } else {
          bad++;
        }
      }
      console.log('');
    }
  }

  if (ok + bad === 0) {
    console.log('No studies here. Nothing in this folder parsed as DICOM.');
    process.exitCode = 1;
    return;
  }

  console.log(`${ok} series the viewer can open or does not need to, ${bad} it cannot.`);

  if (bad > 0) {
    // The reason above is the useful part, and it is the thing to send on.
    console.log('\nThe lines marked FAIL say why. That is what to report.');
    process.exitCode = 1;
  }
}

void main();
