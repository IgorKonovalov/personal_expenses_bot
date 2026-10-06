import { crc32, deflateRawSync } from 'node:zlib';

// A minimal zip writer for the XLSX package (ADR-0026): each entry deflated, with its CRC-32, a
// local header, then a central directory and its end record. No Zip64: an archive past the
// classic limits (65 535 entries, 4 GiB sizes and offsets) throws. Every entry carries the same
// fixed timestamp, 1980-01-01 00:00, so the bytes depend only on the entries.

export interface ZipEntry {
  // A forward-slash path, e.g. `xl/workbook.xml`.
  readonly name: string;
  readonly data: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const VERSION = 20;
// Bit 11: the entry name is UTF-8.
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
// MS-DOS date of 1980-01-01: (year - 1980) << 9 | month << 5 | day.
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

export function writeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_U16) throw new RangeError('too many zip entries for a non-Zip64 zip');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const sizes = [compressed.length, entry.data.length];
    if (offset > MAX_U32 || sizes.some((size) => size > MAX_U32) || name.length > MAX_U16) {
      throw new RangeError(`zip entry ${entry.name} is past the non-Zip64 limits`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, internal and external attributes: all zero.
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  if (offset > MAX_U32 || directory.length > MAX_U32) {
    throw new RangeError('zip archive is past the non-Zip64 limits');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_RECORD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}
