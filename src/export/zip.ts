/**
 * A minimal ZIP writer.
 *
 * Store-only -- no DEFLATE. That is a deliberate trade: the payload here is a
 * handful of small Java source files, where compression would save a few
 * kilobytes and cost a compression implementation (or a dependency) to build
 * and maintain. A stored ZIP is valid ZIP: every OS unarchiver, every IDE
 * import, and `unzip` all open it without knowing or caring.
 *
 * Only the two structures a reader actually needs are emitted -- a local
 * header per file and a central directory -- with no ZIP64, no data
 * descriptors, and no encryption. Those matter past 4 GB or when streaming
 * with an unknown length ahead of time, neither of which can happen here.
 */

/** Standard CRC-32 (IEEE 802.3), the checksum ZIP entries carry. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date and time, which is what the ZIP header format stores. */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

export interface ZipEntry {
  /** Path inside the archive, using forward slashes. */
  path: string;
  text: string;
}

export function makeZip(entries: ZipEntry[], when: Date = new Date()): Blob {
  const enc = new TextEncoder();
  /* Explicitly ArrayBuffer-backed. TypeScript's newer typed-array types are
     generic over the buffer kind, and Blob will not take a view that might be
     backed by a SharedArrayBuffer -- these never are. */
  const alloc = (n: number) => new Uint8Array(new ArrayBuffer(n));
  const { date, time } = dosDateTime(when);

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const encodedName = enc.encode(entry.path);
    const nameBytes = alloc(encodedName.length);
    nameBytes.set(encodedName);
    const encoded = enc.encode(entry.text);
    const data = alloc(encoded.length);
    data.set(encoded);
    const crc = crc32(data);

    const local = alloc(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);  // local file header signature
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 filename flag
    lv.setUint16(8, 0, true);           // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size == uncompressed
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // no extra field
    local.set(nameBytes, 30);

    const dir = alloc(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);  // central directory signature
    dv.setUint16(4, 20, true);          // version made by
    dv.setUint16(6, 20, true);          // version needed
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);     // offset of this entry's local header
    dir.set(nameBytes, 46);

    chunks.push(local, data);
    central.push(dir);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = alloc(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);    // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);       // where the central directory starts

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
