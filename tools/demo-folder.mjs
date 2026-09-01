/**
 * Keeping the demonstration folder to exactly the studies it is meant to hold.
 *
 * This is here, apart from the script that downloads them, for a reason worth
 * stating. The application indexes everything it finds in that folder and
 * presents it as one library, so anything else left in it — synthetic studies
 * from an older version, a half-finished download, a series dropped from the
 * list — appears as a patient who is not part of the demonstration. That is not
 * hypothetical: a drawn phantom sat there beside four real archives, and what it
 * looked like was a viewer showing a made-up study.
 *
 * The removal was written once inside the download script and never called, and
 * nothing noticed, because a script is not something a test can reach. So it
 * lives here instead, where one can.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * What may be in the folder: every series of every study, by collection.
 *
 * The licence counts. The archive ships it inside the download and it is kept
 * beside the images it applies to, which is the whole point of keeping it.
 */
export function belongsHere(studies) {
  const wanted = new Map();

  for (const study of studies) {
    if (!wanted.has(study.collection)) {
      wanted.set(study.collection, new Set(['LICENSE']));
    }
    for (const series of study.series) {
      wanted.get(study.collection).add(series.seriesInstanceUID);
    }
  }

  return wanted;
}

/**
 * Removes whatever is in the folder and is not one of these studies.
 *
 * Removing rather than warning: the folder belongs to the download script, it
 * is not committed, and everything in it can be fetched again. Returns what
 * went, so the script can say it rather than doing it quietly.
 */
export function tidy(root, studies) {
  const wanted = belongsHere(studies);
  const removed = [];

  if (!fs.existsSync(root)) {
    return removed;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);

    if (!entry.isDirectory() || !wanted.has(entry.name)) {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(entry.name);
      continue;
    }

    for (const inside of fs.readdirSync(full, { withFileTypes: true })) {
      if (!wanted.get(entry.name).has(inside.name)) {
        fs.rmSync(path.join(full, inside.name), { recursive: true, force: true });
        removed.push(`${entry.name}/${inside.name}`);
      }
    }
  }

  return removed;
}
