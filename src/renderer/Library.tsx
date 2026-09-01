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
import type { UnreadableFile } from '../main/dicom/read-header';

import { age, patientKey, patientLabel, readableDate, readableTime } from './format';

import type { LibraryReading } from './useLibrary';

/** Both path separators, so a file name is the last segment on either system. */
const SEPARATORS = new RegExp('[' + String.fromCharCode(92, 92) + '/]');

/**
 * What was picked out of the worklist.
 *
 * Enough to address the viewer, which wants the study and then the series to
 * land on. It used to be the argument to a viewport rendered inside this
 * window; now it is what an address is built from.
 */
export interface Opened {
  patient: Patient;
  study: Study;
  /**
   * Which series to land on, when one was chosen.
   *
   * Absent when the study itself was opened, which is the ordinary way in: the
   * viewer then shows the study and decides what to put up first, which is what
   * it is for. Naming a series is the exception — sending one to a monitor of
   * its own.
   */
  series?: Series;
}

/**
 * One series, as a line of facts.
 *
 * Nothing on this row is a control, and that is the point. What the series tell
 * you is what a study contains before you open it: how many images, how big,
 * and whether the stack could be put in the order it was cut in. Which one to
 * read is a question you can only answer while looking at something, and the
 * viewer is where you look.
 *
 * These used to be buttons, and they lit up under the pointer, so the row that
 * opened a study and the rows that were only describing it were impossible to
 * tell apart.
 */
function SeriesRow({ series }: { series: Series }): React.ReactElement {
  const first = series.instances[0];

  return (
    <li className="series">
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
          series.orderedByGeometry ? 'series__order' : 'series__order series__order--weak'
        }
      >
        {series.orderedByGeometry ? 'by position' : 'by number'}
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
      {/* The study itself opens the study. Having to pick a series first was
          asking somebody to answer a question they have not been shown yet:
          which series is the one to read is what the viewer is for. */}
      <button
        type="button"
        className="study__head"
        onClick={() => onOpen({ patient, study })}
        title="Open this study"
      >
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

      <span className="study__aside">
        {/* Sending a study to a screen is the whole point of a reading room, so
            it is on the row rather than behind a menu. Numbered, because a
            screen is a place and the number is where it is on the desk. */}
        {screens > 1 ? (
          <span className="study__screens">
            {Array.from({ length: screens }, (unused, pane) => (
              <button
                type="button"
                key={pane}
                className="screen"
                title={`Open this study in its own window on screen ${pane + 1}`}
                onClick={() =>
                  void window.workstation.openOnScreen(study.studyInstanceUid, pane)
                }
              >
                {pane + 1}
              </button>
            ))}
          </span>
        ) : null}

        {/* Small, and separate from the row that opens the study: seeing what is
            inside is the rarer thing to want, and it must not be mistaken for
            the way in. */}
        <button
          type="button"
          className="study__toggle"
          aria-expanded={open}
          onClick={() => setOpen(showing => !showing)}
          title={open ? 'Hide the series' : `Show the ${study.series.length} series`}
        >
          {open ? '−' : '+'}
        </button>
      </span>

      {open ? (
        <ul className="series-list">
          {study.series.map(series => (
            <SeriesRow key={series.seriesInstanceUid} series={series} />
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
            <h2>{patientLabel(patient)}</h2>
            {/* Only when it adds something. On a de-identified study the label
                is built from the identifier, and on plenty of others the name
                and the identifier are the same string — printing it twice
                looks like the reader stuttered. */}
            {patient.patientId && !patientLabel(patient).includes(patient.patientId) ? (
              <span className="patient__id">{patient.patientId}</span>
            ) : null}
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
