import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { writeZip, type ZipEntry } from './zip.js';

interface ReadEntry {
  readonly name: string;
  readonly storedCrc: number;
  readonly data: Buffer;
}

// Test-only reader: finds the end record, walks the central directory, and inflates each entry
// from its local header.
function readZip(zip: Buffer): { entryCount: number; entries: ReadEntry[] } {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('no end record');
  const entryCount = zip.readUInt16LE(endAt + 10);
  let at = zip.readUInt32LE(endAt + 16);
  const entries: ReadEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central header');
    const method = zip.readUInt16LE(at + 10);
    const storedCrc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    if (zip.readUInt32LE(localAt) !== 0x04034b50) throw new Error('bad local header');
    const localName = zip.readUInt16LE(localAt + 26);
    const localExtra = zip.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localName + localExtra;
    if (method !== 8) throw new Error('not deflated');
    const data = inflateRawSync(zip.subarray(dataAt, dataAt + compressedSize));
    entries.push({ name, storedCrc, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entryCount, entries };
}

const PARTS: ZipEntry[] = [
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', data: Buffer.from('<workbook>Расходы</workbook>'.repeat(50)) },
  { name: 'xl/empty.xml', data: Buffer.alloc(0) },
];

describe('writeZip', () => {
  it('reads back every part by name, with each stored CRC-32 matching the inflated bytes', () => {
    const { entryCount, entries } = readZip(writeZip(PARTS));

    expect(entryCount).toBe(PARTS.length);
    expect(entries.map((e) => e.name)).toEqual(PARTS.map((p) => p.name));
    for (const [i, entry] of entries.entries()) {
      expect(entry.data.equals(PARTS[i]?.data ?? Buffer.alloc(1))).toBe(true);
      expect(entry.storedCrc).toBe(crc32(entry.data));
    }
  });

  it('starts with a local header and is the same bytes for the same parts', () => {
    const zip = writeZip(PARTS);

    expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    expect(writeZip(PARTS).equals(zip)).toBe(true);
  });

  it('throws past the non-Zip64 entry count', () => {
    const many = Array.from({ length: 65_536 }, (_, i) => ({
      name: `${i}`,
      data: Buffer.alloc(0),
    }));

    expect(() => writeZip(many)).toThrow(RangeError);
  });
});
