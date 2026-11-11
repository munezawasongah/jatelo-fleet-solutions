export class NeedMoreData extends Error {
  constructor() {
    super('need more data');
  }
}

/** Big-endian cursor over a buffer that throws NeedMoreData instead of reading past the end. */
export class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new NeedMoreData();
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}
