import { crcX25 } from './crc.js';

/** Builds a GT06 packet: start, length, protocol, content, serial, CRC, stop. Long (0x7979) form when long=true. */
export function gt06Packet(
  protocol: number,
  content: Buffer,
  serial: number,
  long = false,
): Buffer {
  const lenValue = 1 + content.length + 2 + 2;
  const len = long ? Buffer.alloc(2) : Buffer.alloc(1);
  if (long) len.writeUInt16BE(lenValue);
  else len.writeUInt8(lenValue);
  const ser = Buffer.alloc(2);
  ser.writeUInt16BE(serial & 0xffff);
  const body = Buffer.concat([len, Buffer.from([protocol]), content, ser]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crcX25(body));
  return Buffer.concat([
    Buffer.from(long ? [0x79, 0x79] : [0x78, 0x78]),
    body,
    crc,
    Buffer.from([0x0d, 0x0a]),
  ]);
}
