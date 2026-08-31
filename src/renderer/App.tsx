/**
 * What the window shows: a folder of studies once one is open, and the desk it
 * is standing on until then.
 *
 * The desk is not a placeholder for an empty screen. Everything the workstation
 * does afterwards is placing windows on those panes and putting them back where
 * they were, and being able to see the arrangement the application believes in
 * is what makes that debuggable rather than magic.
 */
import React, { useEffect, useState } from 'react';

import type { Desk } from '../main/display-topology';

import { DeskMap } from './DeskMap';
import { tailOfPath } from './format';
import { Library } from './Library';
import { useLibrary } from './useLibrary';

export function App(): React.ReactElement {
  const [desk, setDesk] = useState<Desk | undefined>(undefined);
  const [changedAt, setChangedAt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const library = useLibrary();

  useEffect(() => {
    void window.workstation.readDesk().then(setDesk);

    // A monitor unplugged mid-session invalidates every placement. The map has
    // to follow the desk, not the moment the window opened.
    return window.workstation.onDeskChanged(next => {
      setDesk(next);
      setChangedAt(n => n + 1);
    });
  }, []);

  // Dropping a folder is how a study arrives from the file manager, and the
  // browser default for a dropped file is to navigate to it — which in a packaged
  // application replaces the entire interface with an image.
  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      library.read(window.workstation.pathOfDropped(file));
    }
  };

  return (
    <main
      className={dragging ? 'shell shell--dragging' : 'shell'}
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="masthead">
        <h1>DICOM Workstation</h1>
        <Where state={library.state} />
        <div className="masthead__actions">
          {library.state.status === 'reading' ? (
            <button type="button" className="button" onClick={library.cancel}>
              Stop
            </button>
          ) : null}
          <button type="button" className="button button--primary" onClick={library.open}>
            Open folder
          </button>
        </div>
      </header>

      <Body desk={desk} deskKey={changedAt} library={library} />

      <footer className="status">
        <span className="status__key">desk</span>
        <span className="status__value">{desk?.fingerprint ?? '...'}</span>
        <span className="status__spacer" />
        <Tally library={library} />
        <span className="status__muted">
          Electron {window.workstation.versions.electron} on {window.workstation.platform}
        </span>
      </footer>
    </main>
  );
}

function Where({ state }: { state: ReturnType<typeof useLibrary>['state'] }): React.ReactElement {
  if (state.status === 'empty') {
    return <p className="masthead__note">No folder open. Drop one anywhere in this window.</p>;
  }

  const folder = state.status === 'ready' ? state.reading.folder : state.folder;

  return (
    <p className="masthead__note masthead__note--path" title={folder}>
      {tailOfPath(folder)}
    </p>
  );
}

function Body({
  desk,
  deskKey,
  library,
}: {
  desk: Desk | undefined;
  deskKey: number;
  library: ReturnType<typeof useLibrary>;
}): React.ReactElement {
  const { state } = library;

  if (state.status === 'reading') {
    const percent = state.total === 0 ? 0 : Math.round((state.done / state.total) * 100);
    return (
      <section className="panel panel--centred">
        <div className="reading">
          <p className="reading__count">
            {state.done}
            <span className="reading__of"> of {state.total || '...'}</span>
          </p>
          <div className="reading__bar">
            <div className="reading__fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">
            Reading headers. The images themselves are not touched, so this is fast even on a
            folder that is not.
          </p>
        </div>
      </section>
    );
  }

  if (state.status === 'failed') {
    return (
      <section className="panel panel--centred">
        <div className="failure">
          <h2>That folder could not be read</h2>
          <p className="failure__reason">{state.reason}</p>
          <button type="button" className="button" onClick={library.open}>
            Choose another
          </button>
        </div>
      </section>
    );
  }

  if (state.status === 'ready') {
    return (
      <section className="panel panel--list">
        <Library reading={state.reading} />
      </section>
    );
  }

  return (
    <section className="panel panel--centred">
      {desk ? (
        <div className="desk">
          <DeskMap desk={desk} key={deskKey} />
          <p className="muted desk__caption">
            {desk.panes.length} {desk.panes.length === 1 ? 'screen' : 'screens'} attached. Windows
            will be placed on these, and remembered against the fingerprint below.
          </p>
        </div>
      ) : (
        <p className="muted">Reading the desk…</p>
      )}
    </section>
  );
}

function Tally({ library }: { library: ReturnType<typeof useLibrary> }): React.ReactElement | null {
  if (library.state.status !== 'ready') {
    return null;
  }
  const { read, skipped, elapsedMs, index } = library.state.reading;

  return (
    <span className="status__muted">
      {read} images in {Math.round(elapsedMs)} ms
      {skipped > 0 ? `, ${skipped} skipped` : ''}
      {index.duplicates > 0 ? `, ${index.duplicates} duplicates` : ''}
    </span>
  );
}
