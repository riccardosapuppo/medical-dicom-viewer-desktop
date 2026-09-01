/**
 * Indexes a folder of DICOM files and prints what is in it.
 *
 * No Electron and no window: this is the indexer on its own, so it can be
 * pointed at a real archive and timed honestly before any of it is wired to an
 * interface.
 *
 *   npm run index -- ./demo-data
 *   npm run index -- ./demo-data --json
 */
import path from 'node:path';
import { givenPath } from './given-path';

import { indexFolder } from '../src/main/dicom/index-folder';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const folder = args.find(a => !a.startsWith('--'));

if (!folder) {
  process.stderr.write('Usage: npm run index -- <folder> [--json]\n');
  process.exit(1);
}

// A caret separates the parts of a name in DICOM, so it is in a great many
// folder names — and a path carrying one arrives doubled when it has come
// through npm and cmd on Windows.
const root = path.resolve(givenPath(folder).folder);

/** 20240310 -> 2024-03-10. Leaves anything unexpected alone. */
function readableDate(raw: string): string {
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
}

function readableSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const result = await indexFolder(root, {
    onProgress: (done, total) => {
      // Only while a terminal is watching, and only on one line: a long walk that
      // prints nothing looks hung, and one that prints a line per file scrolls
      // the answer away.
      if (process.stdout.isTTY && (done % 25 === 0 || done === total)) {
        process.stdout.write(`\r  ${done}/${total} files`);
      }
    },
  });

  if (process.stdout.isTTY) {
    process.stdout.write('\r'.padEnd(40) + '\r');
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.unreadable.length > 0 ? 1 : 0);
  }

  const lines: string[] = [''];

  for (const patient of result.index.patients) {
    lines.push(`${patient.name || `Anonymized — ${patient.patientId}`}   ${patient.patientId}`);

    for (const study of patient.studies) {
      lines.push(
        `  ${readableDate(study.studyDate)}  ${study.description || '(no description)'}` +
          `   ${study.modalities.join('/')}   ${study.instanceCount} images` +
          (study.accessionNumber ? `   acc ${study.accessionNumber}` : '')
      );

      for (const series of study.series) {
        const bytes = series.instances.reduce((sum, i) => sum + i.fileSize, 0);
        const shape = series.instances[0];
        lines.push(
          `    ${String(series.seriesNumber ?? '-').padStart(3)}. ` +
            `${(series.description || '(no description)').padEnd(28)} ` +
            `${String(series.instances.length).padStart(4)} img  ` +
            `${shape?.pixels.columns ?? '?'}x${shape?.pixels.rows ?? '?'}  ` +
            `${readableSize(bytes).padStart(8)}  ` +
            `${series.orderedByGeometry ? 'ordered by position' : 'ordered by number'}`
        );
      }
    }
    lines.push('');
  }

  if (result.index.patients.length === 0) {
    lines.push('No DICOM files found.', '');
  }

  lines.push(
    `${result.read} images read, ${result.skipped} files skipped as not DICOM` +
      (result.index.duplicates ? `, ${result.index.duplicates} duplicates dropped` : '') +
      ` in ${Math.round(result.elapsedMs)} ms`
  );

  // Unreadable files are the ones worth someone's attention: they looked like
  // DICOM and would not parse, which means an image is missing from a study
  // rather than a stray file being ignored.
  for (const bad of result.unreadable) {
    lines.push(`  unreadable: ${path.relative(root, bad.filePath)} — ${bad.reason}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(result.unreadable.length > 0 ? 1 : 0);
}

void main();
