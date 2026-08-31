/**
 * What the window shows.
 *
 * At this stage that is the desk, which is not a placeholder: everything the
 * workstation does afterwards is placing windows on these panes and putting
 * them back where they were, and being able to see the arrangement the
 * application believes in is what makes that debuggable rather than magic.
 */
import React, { useEffect, useState } from 'react';

import type { Desk } from '../main/display-topology';

import { DeskMap } from './DeskMap';

export function App(): React.ReactElement {
  const [desk, setDesk] = useState<Desk | undefined>(undefined);
  const [changedAt, setChangedAt] = useState(0);

  useEffect(() => {
    void window.workstation.readDesk().then(setDesk);

    // A monitor unplugged mid-session invalidates every placement. The map has
    // to follow the desk, not the moment the window opened.
    return window.workstation.onDeskChanged(next => {
      setDesk(next);
      setChangedAt(n => n + 1);
    });
  }, []);

  if (!desk) {
    return <main className="shell shell--empty">Reading the desk…</main>;
  }

  const primary = desk.panes.find(p => p.isPrimary);

  return (
    <main className="shell">
      <header className="masthead">
        <h1>DICOM Workstation</h1>
        <p className="masthead__note">
          No study is open. What follows is the desk this window is running on.
        </p>
      </header>

      <section className="desk">
        <DeskMap desk={desk} key={changedAt} />
      </section>

      <section className="ledger">
        {desk.panes.map(pane => (
          <article className="ledger__row" key={pane.id}>
            <h2>
              {pane.label}
              {pane.isPrimary ? <span className="tag">primary</span> : null}
              {pane.internal ? <span className="tag tag--quiet">built-in</span> : null}
            </h2>
            <dl>
              <div>
                <dt>real pixels</dt>
                <dd>
                  {pane.physical.width} x {pane.physical.height}
                </dd>
              </div>
              <div>
                <dt>scale</dt>
                <dd>{pane.scaleFactor}x</dd>
              </div>
              <div>
                <dt>rotation</dt>
                <dd>{pane.rotation}&deg;</dd>
              </div>
              <div>
                <dt>from primary</dt>
                <dd>
                  {pane.offsetFromPrimary.x}, {pane.offsetFromPrimary.y}
                </dd>
              </div>
              <div>
                <dt>refresh</dt>
                <dd>{pane.displayFrequency ? `${pane.displayFrequency} Hz` : 'not reported'}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>

      <footer className="status">
        <span className="status__key">desk</span>
        <span className="status__value">{desk.fingerprint}</span>
        <span className="status__spacer" />
        <span className="status__muted">
          {desk.panes.length} {desk.panes.length === 1 ? 'screen' : 'screens'}
          {primary ? `, primary ${primary.bounds.width}x${primary.bounds.height}` : ''}
        </span>
        <span className="status__muted">
          Electron {window.workstation.versions.electron} on {window.workstation.platform}
        </span>
      </footer>
    </main>
  );
}

