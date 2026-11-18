declare module "buffer-crc32" {
  const crc32: { unsigned(bytes: Buffer, previous?: number): number };
  export default crc32;
}

declare module "yauzl" {
  export class Entry {
    fileNameRaw: Buffer;
    extraFields: readonly unknown[];
    externalFileAttributes: number;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    relativeOffsetOfLocalHeader: number;
    generalPurposeBitFlag: number;
    crc32: number;
  }

  type ZipFile = {
    entryCount: number;
    eachEntry(): AsyncIterable<Entry>;
    readLocalFileHeaderPromise(
      entry: Entry,
      options: { minimal: true },
    ): Promise<{ fileDataStart: number }>;
    openReadStreamPromise(entry: Entry): Promise<import("node:stream").Readable>;
    close(): void;
  };

  export function fromBufferPromise(
    bytes: Buffer,
    options: { decodeStrings: boolean; validateEntrySizes: boolean },
  ): Promise<ZipFile>;
}
