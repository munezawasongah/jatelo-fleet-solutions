import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  Gt06Decoder,
  QueclinkDecoder,
  TeltonikaDecoder,
  encodeCodec12Command,
  encodeGt06Command,
  type Gt06Frame,
  type QueclinkFrame,
  type TeltonikaFrame,
} from '@jfs/protocols';
import { config } from './config.js';
import { resolveDevice, type DeviceInfo, type Protocol } from './devices.js';
import { redis } from './infra.js';
import { logger } from './logger.js';
import { logRaw, publishCommandResult, publishRecords, publishStatus } from './publish.js';
import { stats } from './stats.js';

export type TcpProtocol = Exclude<Protocol, 'http_json'>;
type AnyFrame = TeltonikaFrame | Gt06Frame | QueclinkFrame;
type Decoder = { push(chunk: Buffer): AnyFrame[] };

export interface SessionHost {
  attach(session: Session): void;
  detach(session: Session): void;
}

const PAUSE_AT = 500;
const RESUME_AT = 100;

export class Session {
  readonly id = randomUUID();
  device: DeviceInfo | null = null;
  pendingCommandId: string | null = null;
  private readonly decoder: Decoder;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastChunk: Buffer = Buffer.alloc(0);
  private serial = 1;
  private closed = false;
  readonly remote: string;
  readonly log;

  constructor(
    private readonly socket: Socket,
    readonly protocol: TcpProtocol,
    private readonly host: SessionHost,
  ) {
    this.remote = socket.remoteAddress ?? '';
    this.log = logger.child({ session: this.id.slice(0, 8), protocol, remote: this.remote });
    this.decoder =
      protocol === 'teltonika'
        ? new TeltonikaDecoder()
        : protocol === 'gt06'
          ? new Gt06Decoder()
          : new QueclinkDecoder();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(config.INGEST_IDLE_TIMEOUT_S * 1000, () => this.close('idle timeout'));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.log.debug({ err }, 'socket error'));
    socket.on('close', () => {
      this.closed = true;
      host.detach(this);
    });
    stats.connectionsOpened++;
  }

  private onData(chunk: Buffer): void {
    this.lastChunk = chunk;
    let frames: AnyFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.log.error({ err }, 'decoder crashed');
      this.close('decoder error');
      return;
    }
    for (const frame of frames) {
      this.pending++;
      if (this.pending >= PAUSE_AT) this.socket.pause();
      this.chain = this.chain
        .then(() => (this.closed ? undefined : this.handle(frame)))
        .catch((err: unknown) => {
          this.log.error({ err }, 'frame handling failed - closing so the device resends');
          this.close('handler error');
        })
        .finally(() => {
          this.pending--;
          if (this.pending <= RESUME_AT && this.socket.isPaused()) this.socket.resume();
        });
    }
  }

  private write(buf: Buffer | undefined): void {
    if (buf && !this.closed) this.socket.write(buf);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.log.debug({ reason, device: this.device?.identifier }, 'closing connection');
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  /** Resolves and binds the device; returns false (and logs) when it may not connect. */
  private async bind(identifier: string): Promise<boolean> {
    if (this.device) return this.device.identifier === identifier;
    const r = await resolveDevice(identifier, this.protocol);
    if (!r.ok) {
      stats.rejected++;
      this.log.warn({ identifier, reason: r.reason }, 'device rejected');
      logRaw({
        identifier,
        protocol: this.protocol,
        remote: this.remote,
        payload: this.lastChunk,
        error: `rejected: ${r.reason}`,
      });
      return false;
    }
    this.device = r.device;
    this.log.info({ identifier }, 'device connected');
    await redis.set(
      `conn:${r.device.id}`,
      `${config.INSTANCE_ID}:${this.id}`,
      'EX',
      config.INGEST_IDLE_TIMEOUT_S * 2,
    );
    this.host.attach(this);
    return true;
  }

  private invalid(reason: string, fatal: boolean, reply?: Buffer): void {
    stats.invalid++;
    logRaw({
      identifier: this.device?.identifier,
      deviceId: this.device?.id,
      tenantId: this.device?.tenantId,
      protocol: this.protocol,
      remote: this.remote,
      payload: this.lastChunk,
      error: reason,
    });
    this.write(reply);
    if (fatal) this.close(reason);
  }

  private async handle(frame: AnyFrame): Promise<void> {
    if (this.device) void redis.expire(`conn:${this.device.id}`, config.INGEST_IDLE_TIMEOUT_S * 2);
    switch (frame.type) {
      case 'login': {
        const ok = await this.bind(frame.imei);
        if (ok) this.write(frame.accept);
        else {
          if ('reject' in frame) this.write(frame.reject);
          this.close('device rejected');
        }
        return;
      }
      case 'records': {
        if ('imei' in frame && !(await this.bind(frame.imei))) return this.close('device rejected');
        if (!this.device) return this.close('records before login');
        await publishRecords(this.device, frame.records);
        this.write(frame.reply);
        return;
      }
      case 'status': {
        if ('imei' in frame && !(await this.bind(frame.imei))) return this.close('device rejected');
        if (!this.device) return this.close('status before login');
        await publishStatus(this.device, frame.status);
        this.write(frame.reply);
        return;
      }
      case 'heartbeat': {
        if (!(await this.bind(frame.imei))) return this.close('device rejected');
        this.write(frame.reply);
        return;
      }
      case 'time_request':
        this.write(frame.reply);
        return;
      case 'command_response':
      case 'command_ack': {
        if (!this.device) return;
        const text = frame.text;
        await publishCommandResult(this.device, this.pendingCommandId, text);
        this.log.info({ text }, 'command response');
        this.pendingCommandId = null;
        return;
      }
      case 'unknown':
        this.log.debug({ protocol: frame.protocol }, 'unsupported packet type ignored');
        return;
      case 'invalid':
        return this.invalid(frame.reason, frame.fatal, 'reply' in frame ? frame.reply : undefined);
    }
  }

  /** Sends a command in this protocol's format. */
  sendCommand(commandId: string, text: string): boolean {
    if (this.closed) return false;
    const buf =
      this.protocol === 'teltonika'
        ? encodeCodec12Command(text)
        : this.protocol === 'gt06'
          ? encodeGt06Command(text, this.serial++)
          : Buffer.from(text.endsWith('$') ? text : `${text}$`, 'latin1');
    this.pendingCommandId = commandId;
    this.socket.write(buf);
    return true;
  }
}
