/**
 * Writes DICOM Part 10 files, in explicit VR little endian.
 *
 * The workstation only ever reads DICOM. This exists so there is something to
 * read: fixtures for the tests, and the synthetic studies the demo ships with.
 * Writing them by hand rather than checking sample files into the repository
 * keeps it small, keeps the licences simple, and means a test can describe the
 * exact awkward file it wants to be sure about — a series whose slices arrive
 * out of order, an instance with no number, a file that stops mid-header.
 *
 * Two rules of the format that are easy to get wrong and silent when you do:
 * elements must be written in ascending tag order, and every value must have
 * an even length. Text is padded with a space, UIDs with a null byte.
 */

/** A value representation, spelled the way the standard spells it. */
export type VR =
  | 'AE' | 'AS' | 'AT' | 'CS' | 'DA' | 'DS' | 'DT' | 'FD' | 'FL' | 'IS'
  | 'LO' | 'LT' | 'OB' | 'OW' | 'PN' | 'SH' | 'SL' | 'SQ' | 'SS' | 'ST'
  | 'TM' | 'UI' | 'UL' | 'UN' | 'US' | 'UT';

export interface Element {
  group: number;
  element: number;
  vr: VR;
  value: string | number | number[] | Uint8Array;
  /**
   * The complete bytes of the element, tag and length included.
   *
   * Escape hatch for the shapes that are not "tag, length, value" — the only
   * one here being encapsulated pixel data, which is a length of all ones
   * followed by a sequence of items. The tag is still given above so the
   * element lands in the right place in the ordering.
   */
  raw?: Uint8Array;
}

/** VRs whose length field is four bytes, behind two reserved ones. */
const LONG_FORM: ReadonlySet<string> = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

/** The separator between repeated values: a backslash, by character code. */
const SEPARATOR = String.fromCharCode(92);

export const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1';
export const IMPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2';
/** CT Image Storage. */
export const CT_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.2';

function encodeValue(vr: VR, value: Element['value']): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (vr === 'US' || vr === 'SS') {
    const numbers = Array.isArray(value) ? value : [Number(value)];
    const out = new Uint8Array(numbers.length * 2);
    const view = new DataView(out.buffer);
    numbers.forEach((n, i) => view.setUint16(i * 2, n, true));
    return out;
  }

  if (vr === 'UL' || vr === 'SL') {
    const numbers = Array.isArray(value) ? value : [Number(value)];
    const out = new Uint8Array(numbers.length * 4);
    const view = new DataView(out.buffer);
    numbers.forEach((n, i) => view.setUint32(i * 4, n, true));
    return out;
  }

  // Everything else travels as text, with a backslash between repeats. No tag
  // this project writes can legitimately contain one, so no escaping is needed.
  const text = Array.isArray(value) ? value.join(SEPARATOR) : String(value);
  const padded = text.length % 2 === 0 ? text : text + (vr === 'UI' ? '\0' : ' ');
  return new Uint8Array(Buffer.from(padded, 'latin1'));
}

function encodeElement({ group, element, vr, value, raw }: Element): Uint8Array {
  if (raw) {
    return raw;
  }
  const body = encodeValue(vr, value);
  const long = LONG_FORM.has(vr);
  const header = new Uint8Array(long ? 12 : 8);
  const view = new DataView(header.buffer);

  view.setUint16(0, group, true);
  view.setUint16(2, element, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);

  if (long) {
    view.setUint32(8, body.length, true);
  } else {
    view.setUint16(6, body.length, true);
  }

  return Buffer.concat([header, body]);
}

/**
 * The same element with the VR left off the wire.
 *
 * Implicit VR little endian is the default transfer syntax, and plenty of
 * archives still store everything in it. A reader has to know every tag's VR
 * from a dictionary instead of being told, which is exactly the case worth
 * having a fixture for.
 */
function encodeImplicitElement({ group, element, vr, value, raw }: Element): Uint8Array {
  if (raw) {
    return raw;
  }
  const body = encodeValue(vr, value);
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);

  view.setUint16(0, group, true);
  view.setUint16(2, element, true);
  view.setUint32(4, body.length, true);

  return Buffer.concat([header, body]);
}

/** Sorts by tag, because a reader is entitled to stop at the first one past what it wants. */
function inTagOrder(elements: Element[]): Element[] {
  return [...elements].sort((a, b) => a.group - b.group || a.element - b.element);
}

const UNDEFINED_LENGTH = 0xffffffff;
const ITEM = { group: 0xfffe, element: 0xe000 };
const SEQUENCE_DELIMITER = { group: 0xfffe, element: 0xe0dd };

function item(tag: { group: number; element: number }, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, tag.group, true);
  view.setUint16(2, tag.element, true);
  view.setUint32(4, body.length, true);
  return Buffer.concat([header, body]);
}

/**
 * Pixel data as a compressed transfer syntax stores it.
 *
 * Not a block of bytes with a length, but a length of all ones followed by
 * items: an offset table, then one item per fragment, then a delimiter. Written
 * here so that "the viewer refuses compressed pixels" can be tested against a
 * file that really is compressed, rather than against one that merely lacks
 * pixel data — which fails for an entirely different reason and would have let
 * a broken refusal pass.
 */
export function encapsulatedPixelData(fragments: Uint8Array[]): Element {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, 0x7fe0, true);
  view.setUint16(2, 0x0010, true);
  header[4] = 'O'.charCodeAt(0);
  header[5] = 'B'.charCodeAt(0);
  view.setUint32(8, UNDEFINED_LENGTH, true);

  const body = Buffer.concat([
    // An empty basic offset table: legal, and what most encoders write.
    item(ITEM, new Uint8Array(0)),
    ...fragments.map(fragment =>
      item(ITEM, fragment.length % 2 === 0 ? fragment : Buffer.concat([fragment, new Uint8Array(1)]))
    ),
    item(SEQUENCE_DELIMITER, new Uint8Array(0)),
  ]);

  return {
    group: 0x7fe0,
    element: 0x0010,
    vr: 'OB',
    value: new Uint8Array(0),
    raw: Buffer.concat([header, body]),
  };
}

export interface FileMeta {
  sopClassUid: string;
  sopInstanceUid: string;
  transferSyntaxUid?: string;
}

/**
 * Assembles a complete file: preamble, magic, file meta group, dataset.
 *
 * The file meta group is always explicit VR little endian whatever the dataset
 * uses, and it starts with its own length — which can only be computed after
 * everything else in the group is encoded, so it is written last and prepended.
 */
export function writeDicomFile(meta: FileMeta, dataset: Element[]): Buffer {
  const transferSyntax = meta.transferSyntaxUid ?? EXPLICIT_VR_LITTLE_ENDIAN;

  const metaElements: Element[] = [
    { group: 0x0002, element: 0x0001, vr: 'OB', value: new Uint8Array([0, 1]) },
    { group: 0x0002, element: 0x0002, vr: 'UI', value: meta.sopClassUid },
    { group: 0x0002, element: 0x0003, vr: 'UI', value: meta.sopInstanceUid },
    { group: 0x0002, element: 0x0010, vr: 'UI', value: transferSyntax },
    { group: 0x0002, element: 0x0012, vr: 'UI', value: '1.2.826.0.1.3680043.10.1337.1' },
  ];

  const metaBody = Buffer.concat(inTagOrder(metaElements).map(encodeElement));
  const groupLength = encodeElement({
    group: 0x0002,
    element: 0x0000,
    vr: 'UL',
    value: metaBody.length,
  });

  const preamble = Buffer.alloc(128);
  const magic = Buffer.from('DICM', 'latin1');
  // The file meta group is always explicit whatever the dataset uses - that is
  // what makes it readable before the transfer syntax inside it has been read.
  const encodeDatasetElement =
    transferSyntax === IMPLICIT_VR_LITTLE_ENDIAN ? encodeImplicitElement : encodeElement;
  const body = Buffer.concat(inTagOrder(dataset).map(encodeDatasetElement));

  return Buffer.concat([preamble, magic, groupLength, metaBody, body]);
}
