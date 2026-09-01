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
import { Start } from './Start';
import { tailOfPath } from './format';
import { Library } from './Library';
import { useLibrary } from './useLibrary';
import type { Opened } from './Library';

export function App(): React.ReactElement {
  const [desk, setDesk] = useState<Desk | undefined>(undefined);
  const [changedAt, setChangedAt] = useState(0);
  const [dragging, setDragging] = useState(false);
  /**
   * Opening hands the window to the viewer, and this page stops existing.
   *
   * The address carries the study, and the series when one was named, so the
   * viewer needs nothing from here: no message that might arrive before it is
   * ready, and no state to keep in step.
   *
   * Nothing is remembered about what was opened, deliberately. Keeping it meant
   * a state change here, and the effect it woke up wrote the title bar one last
   * time on its way out — over the title the main process had just set to the
   * study being opened. The window ended up named after the folder.
   */
  const open = (chosen: Opened): void => {
    void window.workstation.openInViewer(
      chosen.study.studyInstanceUid,
      chosen.series?.seriesInstanceUid
    );
  };
  const [restored, setRestored] = useState<string | undefined>(undefined);
  const [showScreens, setShowScreens] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const library = useLibrary();

  // The screen layout, if a menu asked for it while this page did not exist.
  useEffect(() => {
    void window.workstation.pendingScreens().then(asked => {
      if (asked) {
        setShowScreens(true);
      }
    });
  }, []);

  // The menu is in the main process and the state is here, so the two talk.
  useEffect(() => {
    const stop = [
      window.workstation.onCloseStudy(() => library.close()),
      window.workstation.onShowScreens(() => setShowScreens(true)),
    ];
    return () => stop.forEach(off => off());
  }, [library]);

  // The title bar says which folder is open. Once a study is opened the window
  // belongs to the viewer, and the main process names it after the study — with
  // three windows on three screens the title is the only thing that tells them
  // apart.
  useEffect(() => {
    const folder =
      library.state.status === 'ready' ? tailOfPath(library.state.reading.folder) : '';
    void window.workstation.setTitle(folder);
  }, [library.state]);

  // Re-asked whenever the worklist changes, because reading a folder puts it
  // at the top of the list.
  useEffect(() => {
    void window.workstation.recentFolders().then(setRecent);
  }, [library.state.status]);

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

      <Body
        desk={desk}
        deskKey={changedAt}
        library={library}
        onOpen={open}
        screens={desk?.panes.length ?? 1}
        showScreens={showScreens}
        onLeaveScreens={() => setShowScreens(false)}
        onRestored={setRestored}
        recent={recent}
        dragging={dragging}
      />

      <footer className="status">
        <span className="status__key">desk</span>
        <span className="status__value">{desk?.fingerprint ?? '...'}</span>
        {restored ? <span className="status__said">{restored}</span> : null}
        <span className="status__spacer" />
        <Tally library={library} />
        {/* The product, then what it runs on — in that order, and not only the
            second. A footer that names Electron and never the application is a
            footer written by somebody thinking about the framework. */}
        <span className="status__muted">
          {window.workstation.product.name} {window.workstation.product.version} · Developed by{' '}
          {window.workstation.product.author}
        </span>
        <span className="status__muted status__runtime">
          Electron {window.workstation.versions.electron} on {window.workstation.platform}
        </span>
      </footer>
    </main>
  );
}

function Where({ state }: { state: ReturnType<typeof useLibrary>['state'] }): React.ReactElement {
  if (state.status === 'empty') {
    // The screen below says what to do, at length. Repeating it here in smaller
    // grey type is noise.
    return <p className="masthead__note" />;
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
  onOpen,
  screens,
  showScreens,
  onLeaveScreens,
  onRestored,
  recent,
  dragging,
}: {
  desk: Desk | undefined;
  deskKey: number;
  library: ReturnType<typeof useLibrary>;
  onOpen: (opened: Opened) => void;
  screens: number;
  showScreens: boolean;
  onLeaveScreens: () => void;
  onRestored: (said: string) => void;
  recent: string[];
  dragging: boolean;
}): React.ReactElement {
  const { state } = library;

  // Asked for first, and deliberately. This used to come after the worklist, so
  // with a folder open — which is every time anybody would ask for it — the menu
  // entry did nothing at all.
  if (showScreens) {
    return (
      <section className="panel panel--centred">
        {desk ? (
          <div className="desk">
            <DeskMap desk={desk} key={deskKey} />
            <p className="muted desk__caption">
              {desk.panes.length} {desk.panes.length === 1 ? 'screen is' : 'screens are'} attached.
              A study sent to one of these opens in a window of its own on that glass, and where
              you put it is remembered against the fingerprint below — so the same desk gets the
              same arrangement back, and a different desk gets its own.
            </p>
            <div className="desk__actions">
              <button
                type="button"
                className="button"
                title="Reopen the windows this desk was last arranged with"
                onClick={() => {
                  void window.workstation.restoreArrangement().then(opened => {
                    onRestored(
                      opened > 0
                        ? `${opened} window${opened === 1 ? '' : 's'} reopened`
                        : 'nothing remembered for this desk'
                    );
                  });
                }}
              >
                Restore arrangement
              </button>
              <button type="button" className="button button--primary" onClick={onLeaveScreens}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">Reading the desk…</p>
        )}
      </section>
    );
  }

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
        <Library reading={state.reading} onOpen={onOpen} screens={screens} />
      </section>
    );
  }

  return (
    <section className="panel panel--list">
      <Start
        onFolder={library.open}
        onFiles={library.openFiles}
        onSample={library.openSample}
        recent={recent}
        onRecent={library.read}
        dragging={dragging}
      />
    </section>
  );
}

function Tally({ library }: { library: ReturnType<typeof useLibrary> }): React.ReactElement | null {
  if (library.state.status !== 'ready') {
    return null;
  }
  const { found, read, skipped, elapsedMs, index } = library.state.reading;

  return (
    <span className="status__muted">
      {/* Out of how many were looked at, not just how many turned out to be
          images: somebody who dropped the wrong folder wants to see that it
          held four hundred files and none of them were studies. */}
      {read} of {found} files read in {Math.round(elapsedMs)} ms
      {skipped > 0 ? `, ${skipped} not DICOM` : ''}
      {index.duplicates > 0 ? `, ${index.duplicates} duplicates` : ''}
    </span>
  );
}
