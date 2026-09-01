/**
 * Just the corner of dcmjs this application uses.
 *
 * The package ships no types. Declaring the whole surface would be a guess that
 * rots; declaring the two calls actually made keeps the boundary honest, and
 * anything else reached for stops the build rather than failing at a patient's
 * study.
 */
declare module 'dcmjs' {
  interface ReadOptions {
    /** Stop before this tag, so a header can be read without its image. */
    untilTag?: string;
    includeUntilTagValue?: boolean;
    ignoreErrors?: boolean;
  }

  interface DicomDict {
    /** The dataset, in the JSON form of PS3.18, plus dcmjs's own bookkeeping. */
    dict: Record<string, { vr?: string; Value?: unknown[]; BulkDataURI?: string }>;
    /** The file meta information group, in the same form. */
    meta: Record<string, { vr?: string; Value?: unknown[] }>;
  }

  export const data: {
    DicomMessage: {
      readFile(buffer: ArrayBuffer, options?: ReadOptions): DicomDict;
    };
  };

  const dcmjs: { data: typeof data };
  export default dcmjs;
}
