/**
 * What kind of thing a DICOM object is, when it is not an image.
 *
 * A study is not only pictures. Alongside them an archive stores objects that
 * describe how a picture should be shown, what was found in it, or what was
 * measured — presentation states, reports, key object selections, registrations.
 * They are DICOM, they belong to the series they sit in, and they carry no
 * pixels at all.
 *
 * Reading them as images that failed is how a perfectly good study came to
 * report three broken series. What they need is to be named for what they are.
 */

/** The SOP classes that turn up beside images and hold no pixels. */
const KINDS: ReadonlyArray<{ prefix: string; name: string }> = [
  { prefix: '1.2.840.10008.5.1.4.1.1.11.', name: 'presentation state' },
  { prefix: '1.2.840.10008.5.1.4.1.1.88.', name: 'report' },
  { prefix: '1.2.840.10008.5.1.4.1.1.104.', name: 'encapsulated document' },
  { prefix: '1.2.840.10008.5.1.4.1.1.66.1', name: 'registration' },
  { prefix: '1.2.840.10008.5.1.4.1.1.66.2', name: 'fiducials' },
  { prefix: '1.2.840.10008.5.1.4.1.1.66.3', name: 'deformable registration' },
  { prefix: '1.2.840.10008.5.1.4.1.1.66.5', name: 'surface' },
  { prefix: '1.2.840.10008.5.1.4.1.1.67', name: 'real world value map' },
  { prefix: '1.2.840.10008.5.1.4.1.1.4.2', name: 'spectroscopy' },
  { prefix: '1.2.840.10008.5.1.4.1.1.9.', name: 'waveform' },
  { prefix: '1.2.840.10008.5.1.4.1.1.481.', name: 'radiotherapy object' },
];

/**
 * What this object is, when it is not a picture.
 *
 * Undefined for anything that is one, or that says nothing recognisable — an
 * unknown SOP class with pixels in it is an image as far as this is concerned,
 * which is the safe way round.
 */
export function kindOf(sopClassUid: string): string | undefined {
  if (!sopClassUid) {
    return undefined;
  }

  const found = KINDS.find(kind => sopClassUid.startsWith(kind.prefix));
  return found?.name;
}

/**
 * Whether this object holds an image at all.
 *
 * Two questions, and the file's own answer wins over the catalogue: something
 * with pixel data in it is an image whatever its SOP class claims, and something
 * with none is not, whether or not the class is one this knows the name of.
 */
export function carriesPixels(pixels: { dataOffset: number | undefined }): boolean {
  return pixels.dataOffset !== undefined;
}
