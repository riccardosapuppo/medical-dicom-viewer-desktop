/**
 * The desk, drawn to scale.
 *
 * This exists because the first thing to get wrong in a multi-monitor
 * application is the arrangement itself, and a list of numbers is a bad way to
 * notice that the reporting monitor the system calls the second one is
 * physically on the left. Drawn at the right proportions, in the right
 * positions, it is obvious at a glance — and it stays correct when a cable
 * moves, because it redraws when the desk changes.
 */
import React from 'react';

import type { Desk, Pane } from '../main/display-topology';

/** The bounding box of the whole desk, in the coordinates the system uses. */
function extent(panes: Pane[]): { x: number; y: number; width: number; height: number } {
  const left = Math.min(...panes.map(p => p.bounds.x));
  const top = Math.min(...panes.map(p => p.bounds.y));
  const right = Math.max(...panes.map(p => p.bounds.x + p.bounds.width));
  const bottom = Math.max(...panes.map(p => p.bounds.y + p.bounds.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function DeskMap({ desk }: { desk: Desk }): React.ReactElement {
  const panes = desk.panes;
  const box = extent(panes);

  // A hair of padding inside the viewBox so a monitor at the very edge does not
  // have its border clipped in half.
  const pad = Math.max(box.width, box.height) * 0.02;

  return (
    <svg
      className="desk-map"
      viewBox={`${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${panes.length} screens`}
    >
      {panes.map(pane => {
        const { x, y, width, height } = pane.bounds;
        const inset = Math.min(width, height) * 0.03;

        return (
          <g key={pane.id} className={pane.isPrimary ? 'pane pane--primary' : 'pane'}>
            <rect className="pane__glass" x={x} y={y} width={width} height={height} rx={inset} />
            {/* The work area, so the space the system keeps for itself is
                visible rather than a surprise when a window is placed. */}
            <rect
              className="pane__work-area"
              x={pane.workArea.x}
              y={pane.workArea.y}
              width={pane.workArea.width}
              height={pane.workArea.height}
              rx={inset / 2}
            />
            <text x={x + width / 2} y={y + height / 2 - height * 0.04} className="pane__label">
              {pane.label}
            </text>
            <text x={x + width / 2} y={y + height / 2 + height * 0.09} className="pane__size">
              {pane.physical.width} x {pane.physical.height}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
