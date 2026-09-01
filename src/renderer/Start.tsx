/**
 * What the window shows before a study is open.
 *
 * It used to show a diagram of the monitors attached to the machine, which is
 * true, occasionally useful, and completely wrong as an opening screen: a
 * person who has just installed a DICOM viewer is looking for a way to open a
 * study, not for a picture of their own desk. The desk is still there, under
 * View, where somebody who wants it can find it.
 *
 * Three ways in, because people arrive with their data in three shapes: a
 * folder off an archive, a handful of loose files somebody emailed, and — for
 * anybody who has none of it — a study that ships inside the application, so
 * the thing can be seen working before it is trusted with anything real.
 */
import React from 'react';

import { tailOfPath } from './format';

export interface StartProps {
  onFolder: () => void;
  onFiles: () => void;
  onSample: () => void;
  recent: string[];
  onRecent: (folder: string) => void;
  dragging: boolean;
}

export function Start({
  onFolder,
  onFiles,
  onSample,
  recent,
  onRecent,
  dragging,
}: StartProps): React.ReactElement {
  return (
    <section className={dragging ? 'start start--dragging' : 'start'}>
      <div className="start__inner">
        <h2 className="start__lead">Open a study</h2>
        <p className="start__note">
          Drop a folder anywhere in this window, or choose one. Anything that is not DICOM is
          passed over, so a folder straight off a disc is fine.
        </p>

        <div className="start__actions">
          <button type="button" className="button button--primary" onClick={onFolder}>
            Open folder…
          </button>
          <button type="button" className="button" onClick={onFiles}>
            Open files…
          </button>
        </div>

        {recent.length > 0 ? (
          <div className="start__recent">
            <h3>Recently opened</h3>
            <ul>
              {recent.map(folder => (
                <li key={folder}>
                  <button type="button" className="start__recent-item" onClick={() => onRecent(folder)} title={folder}>
                    {tailOfPath(folder)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="start__sample">
          No DICOM to hand?{' '}
          <button type="button" className="start__link" onClick={onSample}>
            Open the sample study
          </button>{' '}
          — twenty-four slices that ship with the application, drawn from a formula.
        </p>
      </div>
    </section>
  );
}
