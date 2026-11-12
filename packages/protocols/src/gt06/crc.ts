/** CRC-ITU as used by Concox GT06 (CRC-16/X-25): reflected poly 0x8408, init 0xFFFF, final XOR 0xFFFF. */
export function crcX25(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}
