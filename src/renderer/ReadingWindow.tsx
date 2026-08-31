/**
 * A window that shows one series and nothing else.
 *
 * This is what opens on a reading monitor: no worklist, no folder, no
 * chrome — the screen is there to hold an image. It is told what to show
 * through the address rather than through a message, so it can start from
 * whatever it finds instead of waiting for something that might arrive before
 * it is ready or after it has given up.
 */
import React, { useEffect, useState } from 'react';

import type { Index } from '../main/dicom/build-index';

import { Viewport, type Opened } from './viewer/Viewport';

/** Finds a series, and the patient and study it belongs to, in an index. */
function find(index: Index, seriesInstanceUid: string): Opened | undefined {
  for (const patient of index.patients) {
    for (const study of patient.studies) {
      for (const series of study.series) {
        if (series.seriesInstanceUid === seriesInstanceUid) {
          return { patient, study, series };
        }
      }
    }
  }
  return undefined;
}

export function ReadingWindow({ seriesInstanceUid }: { seriesInstanceUid: string }): React.ReactElement {
  const [opened, setOpened] = useState<Opened | undefined>(undefined);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    void window.workstation.currentReading().then(current => {
      const index = (current as { index?: Index } | undefined)?.index;
      const found = index ? find(index, seriesInstanceUid) : undefined;
      if (found) {
        setOpened(found);
      } else {
        // The folder was closed or replaced between this window being asked for
        // and it opening. Saying so beats an empty black rectangle.
        setGone(true);
      }
    });
  }, [seriesInstanceUid]);

  if (gone) {
    return (
      <main className="shell shell--reading shell--empty">
        <p>That series is not in the folder that is open.</p>
      </main>
    );
  }

  if (!opened) {
    return <main className="shell shell--reading shell--empty">Opening…</main>;
  }

  return (
    <main className="shell shell--reading">
      <Viewport
        opened={opened}
        onClose={() => void window.workstation.closeReading(seriesInstanceUid)}
        detached
      />
    </main>
  );
}
