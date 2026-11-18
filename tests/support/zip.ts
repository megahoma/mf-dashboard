import { crc32, deflateRawSync } from "node:zlib";

export function zipFixture(
  records: {
    file: string;
    text: string;
    attr?: number;
    deflate?: boolean;
    descriptor?: boolean;
    size?: number;
    crc?: number;
    localOffset?: number;
    unicodePath?: string;
    extraFields?: Buffer;
  }[],
): Buffer<ArrayBuffer> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const record of records) {
    const localStart = offset;
    const name = Buffer.from(record.file);
    const plain = Buffer.from(record.text);
    const data = record.deflate ? deflateRawSync(plain) : plain;
    const info = Buffer.alloc(20);
    if (record.descriptor) info.writeUInt16LE(0x08);
    info.writeUInt16LE(record.deflate ? 8 : 0, 2);
    info.writeUInt32LE(record.crc ?? crc32(plain), 8);
    info.writeUInt32LE(data.length, 12);
    info.writeUInt32LE(record.size ?? plain.length, 16);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    info.copy(header, 6);
    if (record.descriptor) header.fill(0, 14, 26);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    offset += header.length + name.length + data.length;
    if (record.descriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50);
      info.copy(descriptor, 4, 8);
      local.push(descriptor);
      offset += descriptor.length;
    }

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    info.copy(entry, 8);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(record.attr ?? 0, 38);
    entry.writeUInt32LE(record.localOffset ?? localStart, 42);
    const extras = record.extraFields ? [record.extraFields] : [];
    if (record.unicodePath !== undefined) {
      const alias = Buffer.from(record.unicodePath);
      const extra = Buffer.alloc(9);
      extra.writeUInt16LE(0x7075);
      extra.writeUInt16LE(5 + alias.length, 2);
      extra[4] = 1;
      extra.writeUInt32LE(crc32(name), 5);
      extras.push(extra, alias);
    }
    entry.writeUInt16LE(
      extras.reduce((length, extra) => length + extra.length, 0),
      30,
    );
    central.push(entry, name, ...extras);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(
    central.reduce((length, part) => length + part.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
