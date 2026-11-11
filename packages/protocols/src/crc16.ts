/** CRC-16/IBM (a.k.a. CRC-16/ARC): poly 0xA001 reflected, init 0. Used by Teltonika. */
export function crc16Ibm(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}
