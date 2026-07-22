const path = require("node:path");
const zlib = require("node:zlib");

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[n] = value >>> 0;
}

function zipError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeZipPath(value, directory = false) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw zipError("ZIP_PATH_INVALID");
  }
  const normalized = path.posix.normalize(raw.replace(/\/+$/, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw zipError("ZIP_PATH_INVALID");
  }
  return directory ? `${normalized}/` : normalized;
}

function dosTimestamp(dateValue) {
  const date = dateValue instanceof Date && !Number.isNaN(dateValue.getTime()) ? dateValue : new Date();
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function createZip(entries) {
  if (!Array.isArray(entries) || entries.length > 0xffff) throw zipError("ZIP_TOO_MANY_ENTRIES");
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const directory = !!entry.directory;
    const name = safeZipPath(entry.name, directory);
    const nameBuffer = Buffer.from(name, "utf8");
    const data = directory ? Buffer.alloc(0) : Buffer.from(entry.data || "");
    const checksum = crc32(data);
    const { time, day } = dosTimestamp(entry.mtime);
    if (nameBuffer.length > 0xffff || data.length > 0xffffffff) throw zipError("ZIP_ENTRY_TOO_LARGE");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(directory ? 0x10 : 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function findEocd(buffer) {
  const lowerBound = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
  }
  throw zipError("ZIP_INVALID");
}

function extractZip(input, options = {}) {
  const buffer = Buffer.from(input || []);
  if (buffer.length < 22) throw zipError("ZIP_INVALID");
  const maxEntries = options.maxEntries || 10000;
  const maxUncompressedSize = options.maxUncompressedSize || 100 * 1024 * 1024;
  const eocd = findEocd(buffer);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw zipError("ZIP_UNSUPPORTED");
  const diskEntryCount = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskEntryCount !== entryCount || entryCount > maxEntries || centralOffset + centralSize !== eocd) throw zipError("ZIP_INVALID");

  const files = new Map();
  const directories = new Set();
  let totalSize = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw zipError("ZIP_INVALID");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.length || flags & 0x0001 || ![0, 8].includes(method)) throw zipError("ZIP_UNSUPPORTED");
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const directory = rawName.endsWith("/");
    const name = safeZipPath(rawName, directory);
    const plainName = directory ? name.slice(0, -1) : name;
    if (files.has(name) || files.has(plainName) || directories.has(name) || directories.has(`${plainName}/`)) {
      throw zipError("ZIP_INVALID");
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw zipError("ZIP_INVALID");
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (dataOffset + compressedSize > buffer.length || localFlags !== flags || localMethod !== method || localName !== rawName) {
      throw zipError("ZIP_INVALID");
    }

    if (directory) {
      if (compressedSize !== 0 || uncompressedSize !== 0) throw zipError("ZIP_INVALID");
      directories.add(name);
    } else {
      totalSize += uncompressedSize;
      if (totalSize > maxUncompressedSize) throw zipError("ZIP_TOO_LARGE");
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      let data;
      try {
        data = method === 0
          ? Buffer.from(compressed)
          : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, maxUncompressedSize - totalSize + uncompressedSize) });
      } catch {
        throw zipError("ZIP_INVALID");
      }
      if (data.length !== uncompressedSize || crc32(data) !== checksum) throw zipError("ZIP_INVALID");
      files.set(name, data);
    }
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw zipError("ZIP_INVALID");
  for (const name of [...files.keys(), ...directories]) {
    const parts = name.replace(/\/$/, "").split("/");
    for (let index = 1; index < parts.length; index++) {
      if (files.has(parts.slice(0, index).join("/"))) throw zipError("ZIP_INVALID");
    }
  }
  return { files, directories };
}

module.exports = { createZip, extractZip, crc32, safeZipPath };
