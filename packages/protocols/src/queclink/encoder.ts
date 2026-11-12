export interface QueclinkFix {
  /** HDOP-like accuracy, 0 = no fix. */
  accuracy?: number;
  speedKph?: number;
  azimuth?: number;
  altitude?: number;
  lat: number;
  lng: number;
  time: Date;
}

export interface QueclinkReport {
  message: string;
  imei: string;
  version?: string;
  deviceName?: string;
  extVoltageMv?: number;
  /** Report id/type field before the position count (GTHBM: last digit = harsh type). */
  reportType?: string;
  fixes: QueclinkFix[];
  mileageKm?: number;
  hourMeter?: string;
  backupBatteryPct?: number;
  deviceStatus?: string;
  sendTime: Date;
  count: number;
  buffered?: boolean;
}

const utc = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}` +
  `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;

/** GV300-style ASCII report (documented field order) - used by the simulator and tests. */
export function encodeQueclinkReport(r: QueclinkReport): Buffer {
  const fields: (string | number)[] = [
    `+${r.buffered ? 'BUFF' : 'RESP'}:${r.message}`,
    r.version ?? '300400',
    r.imei,
    r.deviceName ?? 'GV300',
    r.extVoltageMv ?? '',
    r.reportType ?? '10',
    r.fixes.length,
  ];
  for (const x of r.fixes) {
    fields.push(
      x.accuracy ?? 1,
      (x.speedKph ?? 0).toFixed(1),
      Math.round(x.azimuth ?? 0),
      (x.altitude ?? 0).toFixed(1),
      x.lng.toFixed(6),
      x.lat.toFixed(6),
      utc(x.time),
      '0639',
      '0002',
      '0001',
      '0001',
      '00',
    );
  }
  fields.push(
    r.mileageKm !== undefined ? r.mileageKm.toFixed(1) : '',
    r.hourMeter ?? '',
    '',
    '',
    r.backupBatteryPct ?? '',
    r.deviceStatus ?? '',
    '',
    '',
    '',
    utc(r.sendTime),
    r.count.toString(16).toUpperCase().padStart(4, '0'),
  );
  return Buffer.from(`${fields.join(',')}$`, 'latin1');
}

export function encodeQueclinkHeartbeat(
  imei: string,
  sendTime: Date,
  count: number,
  version = '300400',
): Buffer {
  return Buffer.from(
    `+ACK:GTHBD,${version},${imei},GV300,${utc(sendTime)},${count.toString(16).toUpperCase().padStart(4, '0')}$`,
    'latin1',
  );
}
