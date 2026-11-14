// oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- the ZIP format and CRC-32 are bit fields; `>>> 0` converts to unsigned 32-bit, which Math.trunc does not.
import { deflateRawSync } from "node:zlib";

import { VokeDeployError } from "voke";

export interface ZipEntry {
  /** Path inside the archive; forward slashes. */
  path: string;
  data: Uint8Array;
}

// Classic (non-ZIP64) limits: 32-bit sizes and offsets, 16-bit entry count.
const maxClassicSize = 0xff_ff_ff_ff;
const maxClassicEntries = 0xff_ff;
// 1980-01-01 00:00 in DOS date/time format, so identical input gives identical bytes.
const fixedDosTime = 0;
const fixedDosDate = (0 << 9) | (1 << 5) | 1;
// "Version made by" Unix (3) with spec 2.0, and rw-r--r-- in the external attributes:
// Lambda rejects files its runtime user cannot read.
const versionMadeByUnix = (3 << 8) | 20;
const versionNeeded = 20;
const unixFileMode = 0o10_0644;
const deflateMethod = 8;

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

const crc32 = (data: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;

  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const assertClassicSize = (value: number, what: string): void => {
  if (value > maxClassicSize) {
    throw new VokeDeployError(
      `The deployment bundle is too large to package: ${what} exceeds 4 GiB. Split the project or keep large dependencies external.`
    );
  }
};

const normalizePath = (path: string): string =>
  path.replaceAll("\\", "/").replace(/^\/+/u, "");

interface PreparedEntry {
  compressed: Uint8Array;
  crc: number;
  name: Uint8Array;
  size: number;
}

const prepare = (entry: ZipEntry): PreparedEntry => {
  const compressed = deflateRawSync(entry.data);
  const name = new TextEncoder().encode(normalizePath(entry.path));

  assertClassicSize(entry.data.byteLength, entry.path);
  assertClassicSize(compressed.byteLength, entry.path);

  return {
    compressed,
    crc: crc32(entry.data),
    name,
    size: entry.data.byteLength,
  };
};

const localHeader = (entry: PreparedEntry): Uint8Array => {
  const header = new DataView(new ArrayBuffer(30));

  header.setUint32(0, 0x04_03_4b_50, true);
  header.setUint16(4, versionNeeded, true);
  header.setUint16(6, 0, true);
  header.setUint16(8, deflateMethod, true);
  header.setUint16(10, fixedDosTime, true);
  header.setUint16(12, fixedDosDate, true);
  header.setUint32(14, entry.crc, true);
  header.setUint32(18, entry.compressed.byteLength, true);
  header.setUint32(22, entry.size, true);
  header.setUint16(26, entry.name.byteLength, true);
  header.setUint16(28, 0, true);

  return new Uint8Array(header.buffer);
};

const centralHeader = (entry: PreparedEntry, offset: number): Uint8Array => {
  const header = new DataView(new ArrayBuffer(46));

  header.setUint32(0, 0x02_01_4b_50, true);
  header.setUint16(4, versionMadeByUnix, true);
  header.setUint16(6, versionNeeded, true);
  header.setUint16(8, 0, true);
  header.setUint16(10, deflateMethod, true);
  header.setUint16(12, fixedDosTime, true);
  header.setUint16(14, fixedDosDate, true);
  header.setUint32(16, entry.crc, true);
  header.setUint32(20, entry.compressed.byteLength, true);
  header.setUint32(24, entry.size, true);
  header.setUint16(28, entry.name.byteLength, true);
  header.setUint16(30, 0, true);
  header.setUint16(32, 0, true);
  header.setUint16(34, 0, true);
  header.setUint16(36, 0, true);
  header.setUint32(38, (unixFileMode << 16) >>> 0, true);
  header.setUint32(42, offset, true);

  return new Uint8Array(header.buffer);
};

const endOfCentralDirectory = (
  count: number,
  size: number,
  offset: number
): Uint8Array => {
  const record = new DataView(new ArrayBuffer(22));

  record.setUint32(0, 0x06_05_4b_50, true);
  record.setUint16(4, 0, true);
  record.setUint16(6, 0, true);
  record.setUint16(8, count, true);
  record.setUint16(10, count, true);
  record.setUint32(12, size, true);
  record.setUint32(16, offset, true);
  record.setUint16(20, 0, true);

  return new Uint8Array(record.buffer);
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
};

/**
 * A deterministic zip archive: entries sorted by path, fixed timestamps, DEFLATE, Unix 0644
 * permissions. Identical entries always produce identical bytes, so the archive hash can name the
 * uploaded artifact.
 */
export const createZip = (entries: readonly ZipEntry[]): Uint8Array => {
  if (entries.length > maxClassicEntries) {
    throw new VokeDeployError(
      `The deployment bundle has ${entries.length} files; the limit is ${maxClassicEntries}. Bundle fewer files.`
    );
  }

  const prepared = entries
    .toSorted((left, right) =>
      normalizePath(left.path).localeCompare(normalizePath(right.path))
    )
    .map(prepare);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const header = localHeader(entry);

    centralParts.push(centralHeader(entry, offset), entry.name);
    localParts.push(header, entry.name, entry.compressed);
    offset +=
      header.byteLength + entry.name.byteLength + entry.compressed.byteLength;
    assertClassicSize(offset, "the archive");
  }

  const central = concat(centralParts);

  return concat([
    ...localParts,
    central,
    endOfCentralDirectory(prepared.length, central.byteLength, offset),
  ]);
};
