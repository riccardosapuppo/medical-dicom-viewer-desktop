/**
 * The reading list: patients, their studies, and the series inside them.
 *
 * A radiologist reads a worklist, not a file tree, so this shows what they
 * would recognise — who, when, what was scanned, how many images — and never
 * a path. The folder structure the study happens to sit in is an accident of
 * how it was copied and tells nobody anything.
 */
import React, { useState } from 'react';

import type { Patient, Series, Study } from '../main/dicom/build-index';
import { undrawable } from '../main/dicom/drawable';
import type { UnreadableFile } from '../main/dicom/read-header';

import { age, patientKey, readableDate, readableTime } from './format';

/** Both path separators, so a file name is the last segment on either system. */
const SEPARATORS = new RegExp('[' + String.fromCharCode(92, 92) + '/]');
import type { Opened } from './viewer/Viewport';
import type { LibraryReading } from './useLibrary';

function SeriesRow({
  series,
  onOpen,
  screens,
}: {
  series: Series;
  onOpen: () => void;
  /** How many panes the desk has, so a series can be sent to one of them. */
  screens: number;
}): React.ReactElement {
  const first = series.instances[0];

  // A series with nothing that can be drawn is listed but not opened: a
  // viewport that opens onto an error is worse than a row that does not respond
  // to a click. What it is NOT is silent — the reason goes on the row, where a
  // hospital CD full of JPEG 2000 would otherwise produce a worklist that is
  // entirely greyed out and says nothing.
  const refusals = series.instances.map(instance => undrawable(instance.pixels));
  const openable = refusals.some(refusal => refusal === undefined);
  const refusal = openable ? undefined : refusals.find(Boolean);

  return (
    <li className="series">
      <button
        type="button"
        className="series__open"
        onClick={onOpen}
        disabled={!openable}
        title={openable ? 'Open this series' : `Not opened: ${refusal?.reason ?? 'nothing to draw'}`}
      >
      <span className="series__number">{series.seriesNumber ?? '--'}</span>
      <span className="series__name">{series.description || 'unnamed series'}</span>
      <span className="series__count">{series.instances.length} img</span>
      <span className="series__shape">
        {first ? `${first.pixels.columns ?? '?'} x ${first.pixels.rows ?? '?'}` : ''}
      </span>
      {/* Worth saying out loud: a stack ordered by number rather than by
          position is a stack that may be upside down, and the only place that
          can be known is here. */}
      <span
        className={
          refusal
            ? 'series__order series__order--weak'
            : series.orderedByGeometry
              ? 'series__order'
              : 'series__order series__order--weak'
        }
      >
        {refusal ? refusal.reason : series.orderedByGeometry ? 'by position' : 'by number'}
      </span>
      </button>

      {/* Sending a series to a screen is the whole point of a reading room, and
          it belongs on the row rather than behind a menu: it is done constantly
          and always to a particular series. */}
      <span className="series__screens">
        {Array.from({ length: screens }, (_, pane) => (
          <button
            type="button"
            key={pane}
            className="screen"
            disabled={!openable}
            title={`Open this series in its own window on screen ${pane + 1}`}
            onClick={() => void window.workstation.openOnScreen(series.seriesInstanceUid, pane)}
          >
            {pane + 1}
          </button>
        ))}
      </span>
    </li>
  );
}

function StudyBlock({
  study,
  patient,
  onOpen,
  screens,
}: {
  study: Study;
  patient: Patient;
  onOpen: (opened: Opened) => void;
  screens: number;
}): React.ReactElement {
  const [open, setOpen] = useState(true);

  return (
    <article className={open ? 'study study--open' : 'study'}>
      <button type="button" className="study__head" onClick={() => setOpen(o => !o)}>
        <span className="study__date">
          {readableDate(study.studyDate)}
          <span className="study__time">{readableTime(study.studyTime)}</span>
        </span>
        <span className="study__description">{study.description || 'no description'}</span>
        <span className="study__modalities">{study.modalities.join(' ') || '--'}</span>
        <span className="study__counts">
          {study.series.length} series &middot; {study.instanceCount} img
        </span>
        <span className="study__accession">{study.accessionNumber}</span>
        <span className="study__age">{age(patient.birthDate, study.studyDate)}</span>
      </button>

      {open ? (
        <ul className="series-list">
          {study.series.map(series => (
            <SeriesRow
              key={series.seriesInstanceUid}
              series={series}
              screens={screens}
              onOpen={() => onOpen({ patient, study, series })}
            />
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/**
 * The files that claimed to be DICOM and would not parse.
 *
 * Not the stray files — those are counted and forgotten. These mean a slice is
 * missing from a study, so they are named.
 */
function Unreadable({
  files,
  lead,
}: {
  files: UnreadableFile[];
  lead?: string;
}): React.ReactElement {
  return (
    <section className="unreadable">
      <h2>{lead ?? `${files.length} files would not read`}</h2>
      <ul>
        {files.slice(0, 12).map(bad => (
          <li key={bad.filePath}>
            <span className="unreadable__file">{bad.filePath.split(SEPARATORS).pop()}</span>
            <span className="unreadable__reason">{bad.reason}</span>
          </li>
        ))}
      </ul>
      {files.length > 12 ? <p className="muted">and {files.length - 12} more</p> : null}
    </section>
  );
}

export function Library({
  reading,
  onOpen,
  screens,
}: {
  reading: LibraryReading;
  onOpen: (opened: Opened) => void;
  screens: number;
}): React.ReactElement {
  const { patients } = reading.index;

  if (patients.length === 0) {
    // "No DICOM files" is the wrong sentence when there were plenty and none of
    // them would parse: that is a folder of broken images, which is somebody's
    // problem, and the list of what failed is the useful part.
    if (reading.unreadable.length > 0) {
      return (
        <section className="library">
          <Unreadable files={reading.unreadable} lead="Nothing in this folder could be read" />
        </section>
      );
    }

    return (
      <section className="library library--empty">
        <p>No DICOM files in this folder.</p>
        <p className="muted">
          {reading.skipped} file{reading.skipped === 1 ? '' : 's'} looked at and passed over.
        </p>
      </section>
    );
  }

  return (
    <section className="library">
      {patients.map(patient => (
        <section className="patient" key={patientKey(patient)}>
          <header className="patient__head">
            <h2>{patient.name || 'unidentified'}</h2>
            <span className="patient__id">{patient.patientId}</span>
            {patient.sex ? <span className="patient__sex">{patient.sex}</span> : null}
            <span className="patient__studies">
              {patient.studies.length} stud{patient.studies.length === 1 ? 'y' : 'ies'}
            </span>
          </header>

          {patient.studies.map(study => (
            <StudyBlock
              key={study.studyInstanceUid}
              study={study}
              patient={patient}
              onOpen={onOpen}
              screens={screens}
            />
          ))}
        </section>
      ))}

      {reading.unreadable.length > 0 ? <Unreadable files={reading.unreadable} /> : null}
    </section>
  );
}
