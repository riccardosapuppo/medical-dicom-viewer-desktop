#!/usr/bin/env node
/**
 * Downloads the studies listed in data/studies.json from The Cancer Imaging
 * Archive.
 *
 *   npm run demo-data              into ./demo-data
 *   npm run demo-data -- /a/path   somewhere else
 *
 * These are the same studies the web viewer demonstrates, taken from the same
 * list: the two are the same product, and showing one of them a chest CT and
 * the other a drawn ellipse would say otherwise. What arrives is a folder of
 * files, which is what this application reads anyway — there is no archive to
 * install here.
 *
 * The images are real clinical acquisitions that the archive de-identified
 * before publishing them; every collection is Creative Commons Attribution,
 * and the attribution they require is in data/studies.json and in the README.
 * Nothing is committed to this repository: the files land in a folder that is
 * ignored, so a clone stays small and the licence terms stay simple.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tidy } from './demo-folder.mjs';
import { unzip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'studies.json'), 'utf8'));
const where = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const outputRoot = path.resolve(where ?? path.join(root, 'demo-data'));

const endpoint = `${manifest.source.api}/getImage`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Downloads one archive, retrying on a dropped connection.
 *
 * Several hundred megabytes over a public endpoint will occasionally fail
 * halfway, and a setup step that has to be started again from the beginning
 * because of one dropped socket is a setup step people stop trusting.
 */
async function download(url, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`the archive answered ${response.status} ${response.statusText}`);
      }
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length === 0) {
        throw new Error('the archive returned an empty response');
      }
      return archive;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      const pause = attempt * 4000;
      process.stdout.write(`
    ${error.message}; retrying in ${pause / 1000}s `);
      await wait(pause);
    }
  }
}

/** A DICOM file carries its magic 128 bytes in, after the preamble. */
function isDicom(data) {
  return data.length > 132 && data.toString('latin1', 128, 132) === 'DICM';
}

async function fetchSeries(series, collection) {
  const target = path.join(outputRoot, collection, series.seriesInstanceUID);

  if (fs.existsSync(target)) {
    const have = fs.readdirSync(target).filter(name => name.endsWith('.dcm')).length;
    if (have === series.imageCount) {
      console.log(`  = ${series.description}: ${plural(have, 'image')} already downloaded`);
      return have;
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  process.stdout.write(`  · ${series.description}: downloading ... `);
  const archive = await download(`${endpoint}?SeriesInstanceUID=${series.seriesInstanceUID}`);

  const files = unzip(archive);
  const images = files.filter(file => isDicom(file.data));

  // The archive ships the collection's licence inside the download. It is kept
  // next to the images rather than discarded: it is the licence those images
  // are distributed under, stated by the party distributing them.
  const licences = files.filter(file => !isDicom(file.data) && /licen[cs]e/i.test(file.name));
  const unexpected = files.filter(file => !isDicom(file.data) && !licences.includes(file));
  if (unexpected.length > 0) {
    throw new Error(`the download contains files that are neither DICOM nor a licence: ${unexpected.map(f => f.name).join(', ')}`);
  }

  fs.mkdirSync(target, { recursive: true });
  for (const licence of licences) {
    fs.writeFileSync(path.join(outputRoot, collection, 'LICENSE'), licence.data);
  }
  images
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    .forEach((file, index) => {
      fs.writeFileSync(path.join(target, `${String(index + 1).padStart(4, '0')}.dcm`), file.data);
    });

  const megabytes = (archive.length / 1024 / 1024).toFixed(1);
  const warning = images.length === series.imageCount ? '' : ` (manifest says ${series.imageCount})`;
  console.log(`${plural(images.length, 'image')}, ${megabytes} MB${warning}`);
  return images.length;
}

async function main() {
  console.log('Downloading from', manifest.source.archive);
  for (const [name, collection] of Object.entries(manifest.collections)) {
    console.log(`  ${name}: ${collection.license}, doi ${collection.doi}`);
  }

  let total = 0;
  for (const study of manifest.studies) {
    console.log(`\n${study.label} (${study.collection})`);
    for (const series of study.series) {
      total += await fetchSeries(series, study.collection);
    }
  }

  const removed = tidy(outputRoot, manifest.studies);
  if (removed.length > 0) {
    const things = removed.length === 1 ? 'thing' : 'things';
    console.log(`\nRemoved ${removed.length} ${things} not part of these studies:`);
    for (const name of removed.slice(0, 10)) {
      console.log(`  - ${name}`);
    }
    if (removed.length > 10) {
      console.log(`  ... and ${removed.length - 10} more`);
    }
  }

  console.log(`\n${plural(total, 'image')} in ${outputRoot}`);
  console.log('Open that folder in the application: File, then Open folder.');
}

main().catch(error => {
  console.error(`\nDownload failed: ${error.message}`);
  process.exitCode = 1;
});
