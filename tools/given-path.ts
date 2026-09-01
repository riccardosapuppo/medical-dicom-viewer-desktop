/**
 * The folder somebody typed, as it exists on the disc.
 *
 * A path handed to a command-line tool through `npm run` on Windows passes
 * through cmd twice, and cmd treats `^` as an escape character. It arrives
 * doubled: a folder called
 *
 *   DOE^JANE-1.2.826.0.1...
 *
 * is read as `DOE^^JANE-1.2.826.0.1...`, and the tool says there is nothing
 * there. That is not a corner case — `^` is what separates the parts of a name
 * in DICOM, so it is in the folder name of a great many real studies, which are
 * exactly the folders these tools exist to look at.
 *
 * So a path that is not there is tried once more with the doubling undone, and
 * only used if that one really exists. Nothing is guessed: the disc is asked.
 */
import fs from 'node:fs';

export interface Given {
  /** The path to use. */
  folder: string;
  /** Set when the path had to be corrected, so the tool can say so. */
  corrected?: string;
}

export function givenPath(argument: string): Given {
  if (!argument || fs.existsSync(argument)) {
    return { folder: argument };
  }

  const doubled = '^^';
  if (!argument.includes(doubled)) {
    return { folder: argument };
  }

  const undoubled = argument.split(doubled).join('^');

  return fs.existsSync(undoubled)
    ? { folder: undoubled, corrected: argument }
    : { folder: argument };
}
