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

import { age, readableDate, readableTime } from './format';
import type { Opened } from './viewer/Viewport';
import type { LibraryReading } from './useLibrary';

function SeriesRow({
  series,
  onOpen,
}: {
  series: Series;
  onOpen: () => void;
}): React.ReactElement {
  const first = series.instances[0];
  // A series with nothing in it, or nothing that can be drawn, is listed but
  // not opened: a viewport that opens onto an error is worse than a row that
  // does not respond to a click.
  const openable = series.instances.some(i => i.pixels.complete && !i.pixels.encapsulated);

  return (
    <li className="series">
      <button
        type="button"
        className="series__open"
        onClick={onOpen}
        disabled={!openable}
        title={openable ? 'Open this series' : 'Nothing in this series can be displayed yet'}
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
      <span className={series.orderedByGeometry ? 'series__order' : 'series__order series__order--weak'}>
        {series.orderedByGeometry ? 'by position' : 'by number'}
      </span>
      </button>
    </li>
  );
}

function StudyBlock({
  study,
  patient,
  onOpen,
}: {
  study: Study;
  patient: Patient;
  onOpen: (opened: Opened) => void;
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
              onOpen={() => onOpen({ patient, study, series })}
            />
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function Library({
  reading,
  onOpen,
}: {
  reading: LibraryReading;
  onOpen: (opened: Opened) => void;
}): React.ReactElement {
  const { patients } = reading.index;

  if (patients.length === 0) {
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
        <section className="patient" key={patient.patientId}>
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
            />
          ))}
        </section>
      ))}

      {reading.unreadable.length > 0 ? (
        <section className="unreadable">
          <h2>{reading.unreadable.length} files would not read</h2>
          {/* Not the stray files - those are counted and forgotten. These
              claimed to be DICOM and failed, which means a slice is missing
              from a study above. */}
          <ul>
            {reading.unreadable.slice(0, 12).map(bad => (
              <li key={bad.filePath}>
                <span className="unreadable__file">{bad.filePath.split(/[\/]/).pop()}</span>
                <span className="unreadable__reason">{bad.reason}</span>
              </li>
            ))}
          </ul>
          {reading.unreadable.length > 12 ? (
            <p className="muted">and {reading.unreadable.length - 12} more</p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
