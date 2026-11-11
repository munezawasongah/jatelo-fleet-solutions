import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { requireEnv } from '../env.js';

type Row = Record<string, unknown>;
type Db = pg.Client;
type LngLat = [number, number];

// ---------------------------------------------------------------- helpers
let inserted = 0;

/** Deterministic UUID (v5-style) so the seed is idempotent. */
function uid(key: string): string {
  const h = createHash('sha1').update(`jatelo-fleet-seed-v1:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

async function ins(db: Db, table: string, row: Row): Promise<boolean> {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
    .map((_, i) => `$${i + 1}`)
    .join(', ')}) ON CONFLICT ${'id' in row ? '(id) ' : ''}DO NOTHING`;
  const r = await db.query(
    sql,
    cols.map((c) => row[c]),
  );
  const ok = (r.rowCount ?? 0) > 0;
  if (ok) inserted++;
  return ok;
}

const DAY = 86_400_000;
const NOW = Date.now();
const at = (days: number): Date => new Date(NOW + days * DAY);
const dateOnly = (days: number): string => at(days).toISOString().slice(0, 10);
const pt = (lng: number, lat: number): string => `SRID=4326;POINT(${lng} ${lat})`;
const lineStr = (c: LngLat[]): string =>
  `SRID=4326;LINESTRING(${c.map(([x, y]) => `${x} ${y}`).join(', ')})`;
const poly = (c: LngLat[]): string =>
  `SRID=4326;POLYGON((${c.map(([x, y]) => `${x} ${y}`).join(', ')}))`;
const json = (v: unknown): string => JSON.stringify(v);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const hashPw = (p: string): Promise<string> =>
  hash(p, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

// ---------------------------------------------------------------- plans
const F_STARTER = [
  'live_tracking',
  'trip_playback',
  'geofences',
  'alerts',
  'basic_reports',
  'driver_app',
  'mobile_pwa',
];
const F_PRO = [
  ...F_STARTER,
  'maintenance',
  'fuel_management',
  'driver_scoring',
  'dispatch',
  'route_optimisation',
  'scheduled_reports',
  'share_links',
  'inspections',
];
const F_ENT = [
  ...F_PRO,
  'fuel_sensors',
  'can_bus_data',
  'api_access',
  'webhooks',
  'custom_reports',
  'priority_support',
  'dedicated_account_manager',
];

const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    sort: 1,
    features: F_STARTER,
    description: 'Live tracking, trip history, geofences and alerts for small fleets.',
    limits: { max_users: 5, history_days: 90, max_geofences: 50, sms_per_vehicle_month: 20 },
    prices: { KES: 800, TZS: 15000, UGX: 23000, RWF: 8500, USD: 6 },
  },
  {
    code: 'professional',
    name: 'Professional',
    sort: 2,
    features: F_PRO,
    description: 'Adds maintenance, fuel, driver scoring, dispatch and scheduled reports.',
    limits: { max_users: 25, history_days: 180, max_geofences: 500, sms_per_vehicle_month: 60 },
    prices: { KES: 1500, TZS: 28000, UGX: 42000, RWF: 16000, USD: 12 },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    sort: 3,
    features: F_ENT,
    description:
      'Fuel sensors, CAN-bus data, API and webhooks, custom reports and priority support.',
    limits: { max_users: 1000, history_days: 365, max_geofences: 5000, sms_per_vehicle_month: 150 },
    prices: { KES: 2500, TZS: 47000, UGX: 70000, RWF: 27000, USD: 20 },
  },
];

async function seedPlans(db: Db): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const p of PLANS) {
    await ins(db, 'plans', {
      id: uid(`plan:${p.code}`),
      code: p.code,
      name: p.name,
      description: p.description,
      billing_interval: 'month',
      trial_days: 14,
      min_vehicles: 1,
      features: json(p.features),
      limits: json(p.limits),
      sort_order: p.sort,
    });
    const planId = (
      await db.query<{ id: string }>('SELECT id FROM plans WHERE code = $1', [p.code])
    ).rows[0]!.id;
    ids.set(p.code, planId);
    for (const [currency, price] of Object.entries(p.prices)) {
      await ins(db, 'plan_prices', { plan_id: planId, currency, price_per_vehicle: price });
    }
  }
  return ids;
}

// ---------------------------------------------------------------- demo tenant definitions
interface VehicleDef {
  key: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  body: string;
  usage: string;
  fuel: 'diesel' | 'petrol';
  tank: number;
  l100: number;
  group: string;
  governor: boolean;
  odo: number;
  seats?: number;
  protocol: 'teltonika' | 'gt06' | 'queclink' | 'http_json';
  deviceModel: string;
  sinceService: number;
}
interface DriverDef {
  key: string;
  name: string;
  phone: string;
  nationalId: string;
  licence: string;
  classes: string[];
  licenceDays: number;
  psvBadgeDays?: number;
  rfid: string;
}
interface PoiDef {
  key: string;
  name: string;
  category: string;
  lng: number;
  lat: number;
  radius: number;
}
interface TenantDef {
  key: string;
  name: string;
  legalName: string;
  slug: string;
  domain: string;
  taxId: string;
  country: 'KE' | 'TZ';
  currency: 'KES' | 'TZS';
  timezone: string;
  locale: 'en' | 'sw';
  email: string;
  phone: string;
  address: string;
  imeiPrefix: string;
  simPrefix: string;
  simProvider: string;
  costFactor: number;
  insurers: string[];
  docTypes: string[];
  fuelProvider: string;
  cardLast4: string;
  fuelPrices: { diesel: number; petrol: number };
  stations: string[];
  staff: [role: string, name: string, emailLocal: string][];
  groups: [key: string, name: string, color: string][];
  vehicles: VehicleDef[];
  drivers: DriverDef[];
  pois: PoiDef[];
  depotFences: { poi: string; name: string; radius: number }[];
  polygon: { name: string; coords: LngLat[] };
  corridor: { name: string; coords: LngLat[]; width: number };
}

const TENANTS: TenantDef[] = [
  {
    key: 'lakeside',
    name: 'Lakeside Logistics',
    legalName: 'Lakeside Logistics Limited',
    slug: 'lakeside-logistics',
    domain: 'lakeside-logistics.test',
    taxId: 'P051234567X',
    country: 'KE',
    currency: 'KES',
    timezone: 'Africa/Nairobi',
    locale: 'en',
    email: 'ops@lakeside-logistics.test',
    phone: '+254700100200',
    address: 'Obote Road, Kisumu',
    imeiPrefix: '35020910000',
    simPrefix: '+254799',
    simProvider: 'safaricom',
    costFactor: 1,
    insurers: ['Jubilee Insurance', 'APA Insurance', 'Britam General'],
    docTypes: ['insurance', 'ntsa_inspection', 'speed_governor_cert'],
    fuelProvider: 'totalenergies',
    cardLast4: '4821',
    fuelPrices: { diesel: 171.47, petrol: 184.52 },
    stations: ['TotalEnergies Kisumu', 'Rubis Kericho', 'Shell Nakuru'],
    staff: [
      ['company_admin', 'Grace Akinyi', 'admin'],
      ['fleet_manager', 'Peter Ouma', 'fleet'],
      ['dispatcher', 'Faith Wambui', 'dispatch'],
      ['mechanic', 'Samuel Kiptoo', 'workshop'],
      ['accountant', 'Lucy Nyambura', 'accounts'],
    ],
    groups: [
      ['kisumu', 'Kisumu Depot', '#2563EB'],
      ['nairobi', 'Nairobi Depot', '#16A34A'],
      ['longhaul', 'Long Haul', '#DC2626'],
    ],
    vehicles: [
      {
        key: 'v1',
        plate: 'KDA 101A',
        make: 'Isuzu',
        model: 'FRR 90',
        year: 2019,
        body: 'truck',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 200,
        l100: 22,
        group: 'kisumu',
        governor: true,
        odo: 184500,
        protocol: 'teltonika',
        deviceModel: 'FMC130',
        sinceService: 1200,
      },
      {
        key: 'v2',
        plate: 'KDB 202B',
        make: 'Isuzu',
        model: 'NQR',
        year: 2020,
        body: 'truck',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 140,
        l100: 18,
        group: 'kisumu',
        governor: true,
        odo: 132400,
        protocol: 'teltonika',
        deviceModel: 'FMB920',
        sinceService: 9800,
      },
      {
        key: 'v3',
        plate: 'KCZ 303C',
        make: 'Toyota',
        model: 'Hiace',
        year: 2018,
        body: 'minibus',
        usage: 'psv',
        fuel: 'diesel',
        tank: 70,
        l100: 11,
        group: 'nairobi',
        governor: true,
        odo: 241300,
        seats: 14,
        protocol: 'gt06',
        deviceModel: 'Concox GT06N',
        sinceService: 4900,
      },
      {
        key: 'v4',
        plate: 'KDC 404D',
        make: 'Toyota',
        model: 'Hilux',
        year: 2021,
        body: 'pickup',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 80,
        l100: 10.5,
        group: 'nairobi',
        governor: false,
        odo: 88200,
        protocol: 'teltonika',
        deviceModel: 'FMB920',
        sinceService: 300,
      },
      {
        key: 'v5',
        plate: 'KDD 505E',
        make: 'Scania',
        model: 'R460',
        year: 2020,
        body: 'prime_mover',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 600,
        l100: 38,
        group: 'longhaul',
        governor: true,
        odo: 412800,
        protocol: 'teltonika',
        deviceModel: 'FMC130',
        sinceService: 7600,
      },
      {
        key: 'v6',
        plate: 'KDE 606F',
        make: 'Mercedes-Benz',
        model: 'Actros 2644',
        year: 2021,
        body: 'prime_mover',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 600,
        l100: 36,
        group: 'longhaul',
        governor: true,
        odo: 356100,
        protocol: 'queclink',
        deviceModel: 'GV300',
        sinceService: 10400,
      },
      {
        key: 'v7',
        plate: 'KDF 707G',
        make: 'Mitsubishi Fuso',
        model: 'Canter',
        year: 2022,
        body: 'truck',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 100,
        l100: 15,
        group: 'kisumu',
        governor: true,
        odo: 61200,
        protocol: 'gt06',
        deviceModel: 'Concox GT06N',
        sinceService: 2000,
      },
      {
        key: 'v8',
        plate: 'KDG 808H',
        make: 'Nissan',
        model: 'NV350 Caravan',
        year: 2022,
        body: 'van',
        usage: 'commercial',
        fuel: 'petrol',
        tank: 65,
        l100: 12,
        group: 'nairobi',
        governor: false,
        odo: 54300,
        protocol: 'teltonika',
        deviceModel: 'FMB920',
        sinceService: 4950,
      },
    ],
    drivers: [
      {
        key: 'd1',
        name: 'Otieno Odhiambo',
        phone: '+254711000001',
        nationalId: '23456781',
        licence: 'DL-1029384',
        classes: ['B', 'C', 'CE'],
        licenceDays: 420,
        rfid: 'A1B2C3D4',
      },
      {
        key: 'd2',
        name: 'Achieng Atieno',
        phone: '+254711000002',
        nationalId: '24567892',
        licence: 'DL-2039485',
        classes: ['B', 'C1', 'C'],
        licenceDays: 25,
        rfid: 'B2C3D4E5',
      },
      {
        key: 'd3',
        name: 'Kamau Njoroge',
        phone: '+254711000003',
        nationalId: '25678903',
        licence: 'DL-3049586',
        classes: ['B', 'D1', 'D'],
        licenceDays: 610,
        psvBadgeDays: 60,
        rfid: 'C3D4E5F6',
      },
      {
        key: 'd4',
        name: 'Wanjiru Muthoni',
        phone: '+254711000004',
        nationalId: '26789014',
        licence: 'DL-4059687',
        classes: ['B'],
        licenceDays: 800,
        rfid: 'D4E5F6A7',
      },
      {
        key: 'd5',
        name: 'Kiprop Cheruiyot',
        phone: '+254711000005',
        nationalId: '27890125',
        licence: 'DL-5069788',
        classes: ['B', 'C', 'CE'],
        licenceDays: 300,
        rfid: 'E5F6A7B8',
      },
      {
        key: 'd6',
        name: 'Mwangi Kariuki',
        phone: '+254711000006',
        nationalId: '28901236',
        licence: 'DL-6079889',
        classes: ['B', 'C', 'CE'],
        licenceDays: 9,
        rfid: 'F6A7B8C9',
      },
    ],
    pois: [
      {
        key: 'kisumu_depot',
        name: 'Lakeside Kisumu Depot',
        category: 'depot',
        lng: 34.7617,
        lat: -0.1022,
        radius: 150,
      },
      {
        key: 'nairobi_depot',
        name: 'Lakeside Nairobi Depot (Industrial Area)',
        category: 'depot',
        lng: 36.851,
        lat: -1.308,
        radius: 150,
      },
      {
        key: 'mombasa_port',
        name: 'Port of Mombasa (Kilindini)',
        category: 'other',
        lng: 39.657,
        lat: -4.0435,
        radius: 500,
      },
      {
        key: 'busia',
        name: 'Busia One-Stop Border Post',
        category: 'border_post',
        lng: 34.1115,
        lat: 0.4608,
        radius: 300,
      },
      {
        key: 'malaba',
        name: 'Malaba Border Post',
        category: 'border_post',
        lng: 34.282,
        lat: 0.635,
        radius: 300,
      },
      {
        key: 'nakuru_fuel',
        name: 'Nakuru Fuel Stop',
        category: 'fuel_station',
        lng: 36.0667,
        lat: -0.2833,
        radius: 100,
      },
      {
        key: 'athi_weigh',
        name: 'Athi River Weighbridge',
        category: 'weighbridge',
        lng: 36.985,
        lat: -1.456,
        radius: 150,
      },
      {
        key: 'kisumu_garage',
        name: 'Kisumu Diesel Workshop',
        category: 'workshop',
        lng: 34.755,
        lat: -0.095,
        radius: 80,
      },
    ],
    depotFences: [
      { poi: 'kisumu_depot', name: 'Kisumu Depot', radius: 300 },
      { poi: 'nairobi_depot', name: 'Nairobi Depot', radius: 300 },
    ],
    polygon: {
      name: 'Kilindini Port Zone',
      coords: [
        [39.64, -4.07],
        [39.665, -4.07],
        [39.665, -4.04],
        [39.64, -4.04],
        [39.64, -4.07],
      ],
    },
    corridor: {
      name: 'Nairobi - Nakuru Highway (A104)',
      coords: [
        [36.82, -1.28],
        [36.65, -1.1],
        [36.45, -0.95],
        [36.07, -0.28],
      ],
      width: 400,
    },
  },
  {
    key: 'bahari',
    name: 'Bahari Cargo',
    legalName: 'Bahari Cargo Limited',
    slug: 'bahari-cargo',
    domain: 'bahari-cargo.test',
    taxId: '123-456-789',
    country: 'TZ',
    currency: 'TZS',
    timezone: 'Africa/Dar_es_Salaam',
    locale: 'sw',
    email: 'ops@bahari-cargo.test',
    phone: '+255754100200',
    address: 'Kurasini, Dar es Salaam',
    imeiPrefix: '86271003000',
    simPrefix: '+255759',
    simProvider: 'vodacom_tz',
    costFactor: 20,
    insurers: ['Jubilee Allianz', 'Sanlam General', 'NIC Insurance'],
    docTypes: ['insurance', 'road_licence'],
    fuelProvider: 'puma',
    cardLast4: '7390',
    fuelPrices: { diesel: 2847, petrol: 2914 },
    stations: ['Puma Kurasini', 'Oryx Morogoro', 'Total Chalinze'],
    staff: [
      ['company_admin', 'Amina Hassan', 'admin'],
      ['fleet_manager', 'Daudi Mrisho', 'fleet'],
      ['dispatcher', 'Salma Juma', 'dispatch'],
      ['mechanic', 'Emmanuel Mushi', 'workshop'],
      ['accountant', 'Upendo Swai', 'accounts'],
    ],
    groups: [
      ['dar', 'Dar es Salaam Depot', '#2563EB'],
      ['upcountry', 'Upcountry Routes', '#DC2626'],
      ['city', 'City Deliveries', '#16A34A'],
    ],
    vehicles: [
      {
        key: 'v1',
        plate: 'T 245 DGK',
        make: 'Scania',
        model: 'G410',
        year: 2019,
        body: 'prime_mover',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 600,
        l100: 37,
        group: 'upcountry',
        governor: true,
        odo: 398000,
        protocol: 'teltonika',
        deviceModel: 'FMC130',
        sinceService: 8800,
      },
      {
        key: 'v2',
        plate: 'T 318 DHB',
        make: 'Sinotruk',
        model: 'Howo 371',
        year: 2020,
        body: 'prime_mover',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 400,
        l100: 40,
        group: 'upcountry',
        governor: true,
        odo: 287500,
        protocol: 'gt06',
        deviceModel: 'Concox GT06N',
        sinceService: 10300,
      },
      {
        key: 'v3',
        plate: 'T 412 DJM',
        make: 'Isuzu',
        model: 'FVR',
        year: 2021,
        body: 'truck',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 200,
        l100: 24,
        group: 'dar',
        governor: true,
        odo: 143200,
        protocol: 'teltonika',
        deviceModel: 'FMC130',
        sinceService: 2500,
      },
      {
        key: 'v4',
        plate: 'T 509 DKP',
        make: 'Toyota',
        model: 'Land Cruiser 79',
        year: 2020,
        body: 'pickup',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 130,
        l100: 13,
        group: 'upcountry',
        governor: false,
        odo: 167800,
        protocol: 'queclink',
        deviceModel: 'GV300',
        sinceService: 4700,
      },
      {
        key: 'v5',
        plate: 'T 627 DLR',
        make: 'Mitsubishi Fuso',
        model: 'Fighter',
        year: 2022,
        body: 'truck',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 200,
        l100: 21,
        group: 'dar',
        governor: true,
        odo: 72400,
        protocol: 'teltonika',
        deviceModel: 'FMB920',
        sinceService: 600,
      },
      {
        key: 'v6',
        plate: 'T 733 DMS',
        make: 'Suzuki',
        model: 'Carry',
        year: 2023,
        body: 'van',
        usage: 'commercial',
        fuel: 'petrol',
        tank: 40,
        l100: 7.5,
        group: 'city',
        governor: false,
        odo: 38900,
        protocol: 'gt06',
        deviceModel: 'Concox GT06N',
        sinceService: 3900,
      },
      {
        key: 'v7',
        plate: 'MC 845 DNT',
        make: 'TVS',
        model: 'HLX 150',
        year: 2024,
        body: 'motorcycle',
        usage: 'commercial',
        fuel: 'petrol',
        tank: 11,
        l100: 2.5,
        group: 'city',
        governor: false,
        odo: 12100,
        protocol: 'http_json',
        deviceModel: 'Driver phone (Android)',
        sinceService: 1500,
      },
      {
        key: 'v8',
        plate: 'T 951 DPV',
        make: 'Toyota',
        model: 'Hiace',
        year: 2019,
        body: 'van',
        usage: 'commercial',
        fuel: 'diesel',
        tank: 70,
        l100: 11,
        group: 'city',
        governor: false,
        odo: 198600,
        protocol: 'teltonika',
        deviceModel: 'FMB920',
        sinceService: 5100,
      },
    ],
    drivers: [
      {
        key: 'd1',
        name: 'Juma Mwinyi',
        phone: '+255754000001',
        nationalId: '19850101-11111-00001-21',
        licence: '4000123451',
        classes: ['B', 'D', 'E'],
        licenceDays: 500,
        rfid: '1A2B3C4D',
      },
      {
        key: 'd2',
        name: 'Neema Mushi',
        phone: '+255754000002',
        nationalId: '19880202-22222-00002-22',
        licence: '4000123452',
        classes: ['B', 'D', 'E'],
        licenceDays: 18,
        rfid: '2B3C4D5E',
      },
      {
        key: 'd3',
        name: 'Baraka Massawe',
        phone: '+255754000003',
        nationalId: '19900303-33333-00003-23',
        licence: '4000123453',
        classes: ['B', 'D'],
        licenceDays: 700,
        rfid: '3C4D5E6F',
      },
      {
        key: 'd4',
        name: 'Rehema Kimaro',
        phone: '+255754000004',
        nationalId: '19920404-44444-00004-24',
        licence: '4000123454',
        classes: ['B'],
        licenceDays: 365,
        rfid: '4D5E6F7A',
      },
      {
        key: 'd5',
        name: 'Hamisi Said',
        phone: '+255754000005',
        nationalId: '19870505-55555-00005-25',
        licence: '4000123455',
        classes: ['B', 'D'],
        licenceDays: 6,
        rfid: '5E6F7A8B',
      },
      {
        key: 'd6',
        name: 'Zawadi Lyimo',
        phone: '+255754000006',
        nationalId: '19950606-66666-00006-26',
        licence: '4000123456',
        classes: ['A', 'B'],
        licenceDays: 900,
        rfid: '6F7A8B9C',
      },
    ],
    pois: [
      {
        key: 'dar_depot',
        name: 'Bahari Kurasini Depot',
        category: 'depot',
        lng: 39.283,
        lat: -6.846,
        radius: 150,
      },
      {
        key: 'dar_port',
        name: 'Dar es Salaam Port',
        category: 'other',
        lng: 39.295,
        lat: -6.83,
        radius: 500,
      },
      {
        key: 'morogoro_fuel',
        name: 'Morogoro Fuel Stop',
        category: 'fuel_station',
        lng: 37.661,
        lat: -6.821,
        radius: 100,
      },
      {
        key: 'dodoma_hub',
        name: 'Dodoma Customer Hub',
        category: 'customer',
        lng: 35.7516,
        lat: -6.163,
        radius: 150,
      },
      {
        key: 'arusha_branch',
        name: 'Bahari Arusha Branch',
        category: 'depot',
        lng: 36.683,
        lat: -3.3869,
        radius: 150,
      },
      {
        key: 'namanga',
        name: 'Namanga One-Stop Border Post',
        category: 'border_post',
        lng: 36.79,
        lat: -2.545,
        radius: 300,
      },
      {
        key: 'tunduma',
        name: 'Tunduma Border Post',
        category: 'border_post',
        lng: 32.77,
        lat: -9.3,
        radius: 300,
      },
      {
        key: 'mikese_weigh',
        name: 'Mikese Weighbridge',
        category: 'weighbridge',
        lng: 37.91,
        lat: -6.765,
        radius: 150,
      },
    ],
    depotFences: [
      { poi: 'dar_depot', name: 'Kurasini Depot', radius: 300 },
      { poi: 'arusha_branch', name: 'Arusha Branch', radius: 300 },
    ],
    polygon: {
      name: 'Dar es Salaam Port Zone',
      coords: [
        [39.28, -6.845],
        [39.305, -6.845],
        [39.305, -6.82],
        [39.28, -6.82],
        [39.28, -6.845],
      ],
    },
    corridor: {
      name: 'Dar es Salaam - Morogoro Road (A7)',
      coords: [
        [39.2, -6.82],
        [38.9, -6.78],
        [38.4, -6.76],
        [37.66, -6.82],
      ],
      width: 400,
    },
  },
];

const SERVICE_TASKS: [key: string, name: string, category: string, hours: number, cost: number][] =
  [
    ['oil', 'Engine oil & filter service', 'oil_service', 1.5, 6500],
    ['brakes', 'Brake pads & discs check', 'brakes', 2, 9000],
    ['tyres', 'Tyre rotation & alignment', 'tyres', 1.5, 4000],
    ['air', 'Air filter replacement', 'engine', 0.5, 2500],
    ['gearbox', 'Gearbox & differential oil', 'transmission', 2, 8000],
    ['annual', 'Annual roadworthiness inspection', 'inspection', 1, 3000],
  ];

const PARTS: [
  key: string,
  number: string,
  name: string,
  unit: string,
  cost: number,
  qty: number,
  reorder: number,
][] = [
  ['oil_filter', 'OF-ISZ-01', 'Oil filter (Isuzu)', 'pcs', 850, 24, 10],
  ['air_filter', 'AF-ISZ-01', 'Air filter (Isuzu)', 'pcs', 2400, 10, 4],
  ['brake_pads', 'BP-HD-01', 'Brake pads set (heavy duty)', 'set', 7800, 6, 2],
  ['engine_oil', 'EO-15W40', 'Engine oil 15W-40', 'litre', 520, 200, 60],
  ['tyre', 'TY-29580', 'Tyre 295/80 R22.5', 'pcs', 38500, 8, 4],
  ['fuel_filter', 'FF-UNI-01', 'Fuel filter', 'pcs', 1200, 15, 6],
];

const CHECKLIST: [label: string, sw: string, category: string, critical: boolean][] = [
  ['Tyres & wheel nuts', 'Matairi na nati za magurudumu', 'tyres', true],
  ['Brakes (service & parking)', 'Breki (za kawaida na za mkono)', 'brakes', true],
  ['Steering', 'Usukani', 'steering', true],
  ['Lights & indicators', 'Taa na indiketa', 'lights', true],
  ['Seatbelts', 'Mikanda ya usalama', 'safety', true],
  ['Mirrors', 'Vioo vya pembeni na vya ndani', 'body', false],
  ['Horn', 'Honi', 'electrical', false],
  ['Wipers & washer', 'Wipa na maji ya kioo', 'body', false],
  ['Engine oil level', 'Kiwango cha mafuta ya injini', 'engine', false],
  ['Coolant level', 'Kiwango cha maji ya rejeta', 'engine', false],
  ['Fluid leaks', 'Uvujaji wa vimiminika', 'engine', false],
  ['Fire extinguisher', 'Kizima moto', 'safety', true],
  ['First aid kit', 'Kifaa cha huduma ya kwanza', 'safety', false],
  ['Warning triangles', 'Pembetatu za tahadhari', 'safety', false],
  ['Speed governor seal intact', 'Lakiri ya kidhibiti mwendo iko salama', 'compliance', true],
  ['Vehicle documents on board', 'Nyaraka za gari zipo ndani', 'compliance', false],
];

const ALERT_RULES: [
  key: string,
  name: string,
  type: string,
  conditions: Row,
  severity: string,
  channels: string[],
][] = [
  [
    'overspeed',
    'Overspeeding above limit',
    'overspeed',
    { speed_kph: 80, min_duration_s: 10 },
    'warning',
    ['in_app', 'sms'],
  ],
  [
    'harsh',
    'Harsh driving events',
    'harsh_event',
    { types: ['harsh_brake', 'harsh_accel', 'harsh_corner'] },
    'warning',
    ['in_app'],
  ],
  ['sos', 'SOS / panic button', 'sos', {}, 'critical', ['in_app', 'sms', 'push']],
  [
    'offline',
    'Tracker offline for 30 minutes',
    'device_offline',
    { minutes: 30 },
    'warning',
    ['in_app', 'email'],
  ],
  [
    'fuel_drain',
    'Possible fuel theft',
    'fuel_drain',
    { min_litres: 15 },
    'critical',
    ['in_app', 'sms'],
  ],
  ['service', 'Service due', 'service_due', {}, 'info', ['in_app', 'email']],
  [
    'documents',
    'Vehicle document expiring',
    'document_expiry',
    { days_before: [30, 14, 7, 1] },
    'warning',
    ['in_app', 'email'],
  ],
  [
    'licences',
    'Driver licence expiring',
    'licence_expiry',
    { days_before: [30, 14, 7, 1] },
    'warning',
    ['in_app', 'email'],
  ],
  ['depot', 'Arrived at depot', 'geofence_enter', {}, 'info', ['in_app']],
  [
    'after_hours',
    'After-hours vehicle use',
    'after_hours_use',
    { start: '20:00', end: '05:00' },
    'warning',
    ['in_app', 'sms'],
  ],
];

const DOC_EXPIRY = [12, 45, 200, 5, 90, 300, 20, 150];

function iconFor(body: string): string {
  if (body === 'truck' || body === 'prime_mover' || body === 'tanker') return 'truck';
  if (body === 'van' || body === 'minibus' || body === 'bus') return 'van';
  if (body === 'pickup') return 'pickup';
  if (body === 'motorcycle') return 'motorcycle';
  return 'car';
}

function capabilitiesFor(protocol: string, model: string): Row {
  if (protocol === 'teltonika' && model === 'FMC130')
    return { can_bus: true, fuel_sensor: true, rfid: true, harsh_events: true, immobilizer: true };
  if (protocol === 'teltonika')
    return {
      can_bus: false,
      fuel_sensor: false,
      rfid: false,
      harsh_events: true,
      immobilizer: true,
    };
  if (protocol === 'queclink')
    return { can_bus: false, fuel_sensor: true, rfid: true, harsh_events: true, immobilizer: true };
  if (protocol === 'gt06')
    return {
      can_bus: false,
      fuel_sensor: false,
      rfid: false,
      harsh_events: false,
      immobilizer: true,
    };
  return { phone: true, harsh_events: true };
}

// ---------------------------------------------------------------- tenant seeding
async function seedTenant(db: Db, t: TenantDef, pwHash: string, planId: string): Promise<string[]> {
  const T = uid(`tenant:${t.key}`);
  const notes: string[] = [];
  const isHeavy = (v: VehicleDef): boolean => v.body === 'truck' || v.body === 'prime_mover';

  await ins(db, 'tenants', {
    id: T,
    name: t.name,
    legal_name: t.legalName,
    slug: t.slug,
    tax_id: t.taxId,
    country_code: t.country,
    currency: t.currency,
    timezone: t.timezone,
    locale: t.locale,
    email: t.email,
    phone: t.phone,
    address: t.address,
    status: 'trial',
    trial_ends_at: at(14),
  });
  const price =
    (
      await db.query<{ price_per_vehicle: string }>(
        'SELECT price_per_vehicle FROM plan_prices WHERE plan_id = $1 AND currency = $2',
        [planId, t.currency],
      )
    ).rows[0]?.price_per_vehicle ?? '0';
  await ins(db, 'subscriptions', {
    id: uid(`sub:${t.key}`),
    tenant_id: T,
    plan_id: planId,
    status: 'trialing',
    vehicle_quota: 25,
    price_per_vehicle: price,
    currency: t.currency,
    current_period_start: at(0),
    current_period_end: at(14),
  });

  // staff
  const userId = (local: string): string => uid(`user:${t.key}:${local}`);
  for (const [role, name, local] of t.staff) {
    await ins(db, 'users', {
      id: userId(local),
      tenant_id: T,
      email: `${local}@${t.domain}`,
      full_name: name,
      role,
      locale: t.locale,
      status: 'active',
      password_hash: pwHash,
      email_verified_at: at(0),
      password_changed_at: at(0),
    });
  }
  const mechanicId = userId('workshop');

  // groups
  for (const [key, name, color] of t.groups) {
    await ins(db, 'vehicle_groups', {
      id: uid(`group:${t.key}:${key}`),
      tenant_id: T,
      name,
      color,
    });
  }

  // vehicles, devices, assignments, documents
  const vehicleIds: string[] = [];
  for (const [i, v] of t.vehicles.entries()) {
    const V = uid(`vehicle:${t.key}:${v.key}`);
    const D = uid(`device:${t.key}:${v.key}`);
    vehicleIds.push(V);
    await ins(db, 'vehicles', {
      id: V,
      tenant_id: T,
      group_id: uid(`group:${t.key}:${v.group}`),
      plate_number: v.plate,
      fleet_number: `${t.key.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
      label: `${v.make} ${v.model}`,
      make: v.make,
      model: v.model,
      year: v.year,
      body_type: v.body,
      usage_type: v.usage,
      fuel_type: v.fuel,
      tank_capacity_l: v.tank,
      expected_l_per_100km: v.l100,
      seating_capacity: v.seats ?? null,
      speed_governor_fitted: v.governor,
      odometer_km: v.odo,
      engine_hours: Math.round(v.odo / 45),
      odometer_source: v.deviceModel === 'FMC130' ? 'can' : 'gps',
      status: 'active',
      icon: iconFor(v.body),
      purchase_date: `${v.year}-03-01`,
    });
    const identifier =
      v.protocol === 'http_json'
        ? `APP-${t.key.toUpperCase()}-${String(i + 1).padStart(4, '0')}`
        : `${t.imeiPrefix}${String(i + 1).padStart(4, '0')}`;
    const phoneToken = `demo-token-${identifier}`;
    await ins(db, 'devices', {
      id: D,
      tenant_id: T,
      identifier,
      protocol: v.protocol,
      model: v.deviceModel,
      firmware: v.protocol === 'teltonika' ? '03.28.07' : null,
      sim_msisdn: v.protocol === 'http_json' ? null : `${t.simPrefix}${String(100000 + i)}`,
      sim_provider: v.protocol === 'http_json' ? null : t.simProvider,
      auth_token_hash: v.protocol === 'http_json' ? sha256(phoneToken) : null,
      status: 'active',
      capabilities: json(capabilitiesFor(v.protocol, v.deviceModel)),
      installed_at: at(-120),
    });
    if (v.protocol === 'http_json') notes.push(`Phone tracker ${identifier} token: ${phoneToken}`);
    await ins(db, 'device_assignments', {
      id: uid(`da:${t.key}:${v.key}`),
      tenant_id: T,
      device_id: D,
      vehicle_id: V,
      assigned_at: at(-120),
    });
    for (const [j, docType] of t.docTypes.entries()) {
      const expires = DOC_EXPIRY[(i + j * 3) % DOC_EXPIRY.length]!;
      await ins(db, 'vehicle_documents', {
        id: uid(`doc:${t.key}:${v.key}:${docType}`),
        tenant_id: T,
        vehicle_id: V,
        doc_type: docType,
        document_number: `${docType.slice(0, 3).toUpperCase()}-${t.country}-${100200 + i * 7 + j}`,
        provider: docType === 'insurance' ? t.insurers[i % t.insurers.length] : null,
        issued_on: dateOnly(expires - 365),
        expires_on: dateOnly(expires),
      });
    }
  }

  // drivers, driver logins (first three), licences, RFID, assignments
  for (const [i, d] of t.drivers.entries()) {
    const DR = uid(`driver:${t.key}:${d.key}`);
    const first = d.name.split(' ')[0]!.toLowerCase();
    let driverUser: string | null = null;
    if (i < 3) {
      driverUser = userId(first);
      await ins(db, 'users', {
        id: driverUser,
        tenant_id: T,
        email: `${first}@${t.domain}`,
        full_name: d.name,
        role: 'driver',
        phone: d.phone,
        locale: t.locale,
        status: 'active',
        password_hash: pwHash,
        email_verified_at: at(0),
        password_changed_at: at(0),
      });
    }
    await ins(db, 'drivers', {
      id: DR,
      tenant_id: T,
      user_id: driverUser,
      employee_number: `EMP-${String(i + 1).padStart(3, '0')}`,
      full_name: d.name,
      phone: d.phone,
      national_id: d.nationalId,
      hire_date: dateOnly(-400 - i * 90),
      status: 'active',
      emergency_contact_name: 'Next of kin',
      emergency_contact_phone: d.phone.replace(/\d{2}$/, '99'),
    });
    await ins(db, 'driver_licences', {
      id: uid(`lic:${t.key}:${d.key}:driving`),
      tenant_id: T,
      driver_id: DR,
      licence_type: 'driving',
      licence_number: d.licence,
      classes: d.classes,
      issuing_country: t.country,
      issued_on: dateOnly(d.licenceDays - 3 * 365),
      expires_on: dateOnly(d.licenceDays),
    });
    if (d.psvBadgeDays !== undefined) {
      await ins(db, 'driver_licences', {
        id: uid(`lic:${t.key}:${d.key}:psv`),
        tenant_id: T,
        driver_id: DR,
        licence_type: 'psv_badge',
        licence_number: `PSV-${d.licence.slice(-6)}`,
        issuing_country: t.country,
        issued_on: dateOnly(d.psvBadgeDays - 365),
        expires_on: dateOnly(d.psvBadgeDays),
      });
    }
    await ins(db, 'driver_identifiers', {
      id: uid(`rfid:${t.key}:${d.key}`),
      tenant_id: T,
      driver_id: DR,
      kind: 'rfid',
      value: d.rfid,
    });
    const V = vehicleIds[i];
    if (V) {
      await ins(db, 'driver_vehicle_assignments', {
        id: uid(`dva:${t.key}:${d.key}`),
        tenant_id: T,
        driver_id: DR,
        vehicle_id: V,
        starts_at: at(-60),
        assignment_type: 'primary',
        source: 'manual',
      });
    }
  }

  // POIs & geofences
  for (const p of t.pois) {
    await ins(db, 'pois', {
      id: uid(`poi:${t.key}:${p.key}`),
      tenant_id: T,
      name: p.name,
      category: p.category,
      geom: pt(p.lng, p.lat),
      radius_m: p.radius,
    });
  }
  for (const f of t.depotFences) {
    const p = t.pois.find((x) => x.key === f.poi)!;
    await ins(db, 'geofences', {
      id: uid(`fence:${t.key}:${f.poi}`),
      tenant_id: T,
      name: f.name,
      shape: 'circle',
      center: pt(p.lng, p.lat),
      radius_m: f.radius,
      color: '#2563EB',
      poi_id: uid(`poi:${t.key}:${f.poi}`),
    });
  }
  await ins(db, 'geofences', {
    id: uid(`fence:${t.key}:polygon`),
    tenant_id: T,
    name: t.polygon.name,
    shape: 'polygon',
    geom: poly(t.polygon.coords),
    color: '#F59E0B',
  });
  await ins(db, 'geofences', {
    id: uid(`fence:${t.key}:corridor`),
    tenant_id: T,
    name: t.corridor.name,
    shape: 'corridor',
    path: lineStr(t.corridor.coords),
    width_m: t.corridor.width,
    color: '#7C3AED',
    speed_limit_kph: 80,
  });

  // service tasks & schedules
  for (const [key, name, category, hours, cost] of SERVICE_TASKS) {
    await ins(db, 'service_tasks', {
      id: uid(`task:${t.key}:${key}`),
      tenant_id: T,
      name,
      category,
      est_labour_hours: hours,
      est_cost: cost * t.costFactor,
    });
  }
  for (const v of t.vehicles) {
    const V = uid(`vehicle:${t.key}:${v.key}`);
    await ins(db, 'service_schedules', {
      id: uid(`sched:${t.key}:${v.key}:oil`),
      tenant_id: T,
      vehicle_id: V,
      service_task_id: uid(`task:${t.key}:oil`),
      name: 'Engine oil & filter service',
      interval_km: isHeavy(v) ? 10000 : 5000,
      interval_days: 180,
      remind_before_km: isHeavy(v) ? 1000 : 500,
      last_done_km: v.odo - v.sinceService,
      last_done_at: at(-Math.round(v.sinceService / (isHeavy(v) ? 250 : 80))),
    });
    await ins(db, 'service_schedules', {
      id: uid(`sched:${t.key}:${v.key}:annual`),
      tenant_id: T,
      vehicle_id: V,
      service_task_id: uid(`task:${t.key}:annual`),
      name: 'Annual roadworthiness inspection',
      interval_days: 365,
      remind_before_days: 30,
      last_done_at: at(-330),
    });
  }

  // parts with opening stock
  for (const [key, number, name, unit, cost, qty, reorder] of PARTS) {
    const P = uid(`part:${t.key}:${key}`);
    const created = await ins(db, 'parts', {
      id: P,
      tenant_id: T,
      part_number: number,
      name,
      unit,
      unit_cost: cost * t.costFactor,
      currency: t.currency,
      reorder_level: reorder,
      reorder_qty: reorder * 2,
      location: 'Main store',
      supplier_name: 'Demo Motor Spares',
    });
    if (created) {
      await ins(db, 'part_stock_movements', {
        tenant_id: T,
        part_id: P,
        movement_type: 'purchase',
        quantity: qty,
        unit_cost: cost * t.costFactor,
        reference: 'Opening stock',
      });
    }
  }

  // pre-trip checklist
  const TPL = uid(`tpl:${t.key}:pretrip`);
  await ins(db, 'inspection_templates', {
    id: TPL,
    tenant_id: T,
    name: 'Pre-trip inspection',
    inspection_type: 'pre_trip',
    is_default: true,
  });
  for (const [n, [label, sw, category, critical]] of CHECKLIST.entries()) {
    await ins(db, 'inspection_template_items', {
      id: uid(`tpli:${t.key}:${n}`),
      tenant_id: T,
      template_id: TPL,
      seq: n + 1,
      label,
      label_sw: sw,
      category,
      is_critical: critical,
      requires_photo_on_fail: true,
    });
  }

  // alert rules & recipients
  for (const [key, name, type, conditions, severity, channels] of ALERT_RULES) {
    const R = uid(`rule:${t.key}:${key}`);
    await ins(db, 'alert_rules', {
      id: R,
      tenant_id: T,
      name,
      rule_type: type,
      conditions: json(conditions),
      severity,
      channels,
    });
    await ins(db, 'alert_rule_recipients', {
      id: uid(`rcpt:${t.key}:${key}:fleet`),
      tenant_id: T,
      rule_id: R,
      role: 'fleet_manager',
    });
    if (severity === 'critical') {
      await ins(db, 'alert_rule_recipients', {
        id: uid(`rcpt:${t.key}:${key}:admin`),
        tenant_id: T,
        rule_id: R,
        role: 'company_admin',
      });
    }
  }

  // fuel: prices, card, logs
  for (const fuel of ['diesel', 'petrol'] as const) {
    await ins(db, 'fuel_prices', {
      id: uid(`fprice:${t.key}:${fuel}`),
      tenant_id: T,
      fuel_type: fuel,
      price_per_litre: t.fuelPrices[fuel],
      currency: t.currency,
      effective_from: dateOnly(-10),
    });
  }
  const CARD = uid(`card:${t.key}:main`);
  await ins(db, 'fuel_cards', {
    id: CARD,
    tenant_id: T,
    provider: t.fuelProvider,
    card_last4: t.cardLast4,
    label: 'Fleet card - main',
    monthly_limit: 500000 * t.costFactor,
    currency: t.currency,
    expires_on: dateOnly(700),
  });
  for (const [i, v] of t.vehicles.slice(0, 6).entries()) {
    const perDay = isHeavy(v) ? 180 : 90;
    for (let k = 0; k < 3; k++) {
      const daysAgo = k * 6 + 2;
      const litres = Math.round(v.tank * 0.65 - k * 3);
      const price = t.fuelPrices[v.fuel];
      await ins(db, 'fuel_logs', {
        id: uid(`fuel:${t.key}:${v.key}:${k}`),
        tenant_id: T,
        vehicle_id: uid(`vehicle:${t.key}:${v.key}`),
        driver_id: uid(`driver:${t.key}:${t.drivers[i]!.key}`),
        fuel_card_id: CARD,
        filled_at: at(-daysAgo),
        litres,
        unit_price: price,
        total_cost: Math.round(litres * price * 100) / 100,
        currency: t.currency,
        odometer_km: v.odo - daysAgo * perDay,
        is_full_tank: true,
        fuel_type: v.fuel,
        station_name: t.stations[(i + k) % t.stations.length],
        source: 'manual',
        verified: true,
      });
    }
  }

  // work orders (one completed, one open)
  const v0 = t.vehicles[0]!;
  const WO1 = uid(`wo:${t.key}:1`);
  if (
    await ins(db, 'work_orders', {
      id: WO1,
      tenant_id: T,
      number: 'WO-0001',
      vehicle_id: uid(`vehicle:${t.key}:${v0.key}`),
      title: 'Engine oil & filter service',
      wo_type: 'preventive',
      priority: 'normal',
      status: 'completed',
      assigned_to: mechanicId,
      started_at: at(-20),
      completed_at: new Date(at(-20).getTime() + 3 * 3_600_000),
      odometer_km: v0.odo - v0.sinceService,
      currency: t.currency,
    })
  ) {
    for (const [n, item] of [
      {
        item_type: 'labour',
        description: 'Mechanic labour',
        quantity: 1.5,
        unit_cost: 1500 * t.costFactor,
      },
      {
        item_type: 'part',
        description: 'Oil filter (Isuzu)',
        quantity: 1,
        unit_cost: 850 * t.costFactor,
        part_id: uid(`part:${t.key}:oil_filter`),
      },
      {
        item_type: 'part',
        description: 'Engine oil 15W-40',
        quantity: 10,
        unit_cost: 520 * t.costFactor,
        part_id: uid(`part:${t.key}:engine_oil`),
      },
    ].entries()) {
      await ins(db, 'work_order_items', {
        id: uid(`woi:${t.key}:1:${n}`),
        tenant_id: T,
        work_order_id: WO1,
        mechanic_id: mechanicId,
        ...item,
      });
    }
  }
  const v3 = t.vehicles[3]!;
  const WO2 = uid(`wo:${t.key}:2`);
  if (
    await ins(db, 'work_orders', {
      id: WO2,
      tenant_id: T,
      number: 'WO-0002',
      vehicle_id: uid(`vehicle:${t.key}:${v3.key}`),
      title: 'Front brake pads replacement',
      description: 'Driver reported squealing and longer stopping distance.',
      wo_type: 'corrective',
      priority: 'high',
      status: 'open',
      assigned_to: mechanicId,
      scheduled_for: at(1),
      currency: t.currency,
    })
  ) {
    await ins(db, 'work_order_items', {
      id: uid(`woi:${t.key}:2:0`),
      tenant_id: T,
      work_order_id: WO2,
      item_type: 'part',
      description: 'Brake pads set (heavy duty)',
      quantity: 1,
      unit_cost: 7800 * t.costFactor,
      part_id: uid(`part:${t.key}:brake_pads`),
    });
  }

  return notes;
}

// ---------------------------------------------------------------- main
async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'demo';
  if (mode !== 'base' && mode !== 'demo') throw new Error('Usage: seed <base|demo>');
  const production = process.env.NODE_ENV === 'production';
  if (mode === 'demo' && production)
    throw new Error('Demo data cannot be seeded when NODE_ENV=production');

  const adminEmail = process.env.SEED_SUPERADMIN_EMAIL ?? 'evans.onyango@jatelo-techs.com';
  const adminPassword =
    process.env.SEED_SUPERADMIN_PASSWORD ?? (production ? '' : 'Jatelo@Admin2026');
  if (adminPassword.length < 12)
    throw new Error('SEED_SUPERADMIN_PASSWORD must be set and at least 12 characters');
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'Demo@Fleet2026';

  const db = new pg.Client({
    connectionString: requireEnv('DATABASE_URL'),
    application_name: 'jfs-seed',
  });
  await db.connect();
  const notes: string[] = [];
  try {
    await db.query('BEGIN');
    const plans = await seedPlans(db);
    await ins(db, 'users', {
      id: uid('user:superadmin'),
      tenant_id: null,
      email: adminEmail,
      full_name: 'Evans Onyango',
      role: 'super_admin',
      status: 'active',
      password_hash: await hashPw(adminPassword),
      email_verified_at: at(0),
      password_changed_at: at(0),
    });
    if (mode === 'demo') {
      const demoHash = await hashPw(demoPassword);
      for (const t of TENANTS)
        notes.push(...(await seedTenant(db, t, demoHash, plans.get('professional')!)));
    }
    await db.query('COMMIT');

    const c = (
      await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM tenants) AS tenants, (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM vehicles) AS vehicles, (SELECT count(*) FROM devices) AS devices,
      (SELECT count(*) FROM drivers) AS drivers, (SELECT count(*) FROM geofences) AS geofences,
      (SELECT count(*) FROM alert_rules) AS alert_rules, (SELECT count(*) FROM fuel_logs) AS fuel_logs`)
    ).rows[0]!;
    console.log(`Seed (${mode}) complete: ${inserted} new rows.`);
    console.log(
      `Totals: ${Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
    console.log(
      `Super admin: ${adminEmail}${process.env.SEED_SUPERADMIN_PASSWORD ? '' : ' / Jatelo@Admin2026 (local default - change it)'}`,
    );
    if (mode === 'demo') {
      console.log(
        `Demo logins (password ${process.env.SEED_DEMO_PASSWORD ? 'from SEED_DEMO_PASSWORD' : 'Demo@Fleet2026'}):`,
      );
      for (const t of TENANTS) {
        console.log(
          `  ${t.name}: ${t.staff.map(([, , l]) => `${l}@${t.domain}`).join(', ')}, drivers: ${t.drivers
            .slice(0, 3)
            .map((d) => `${d.name.split(' ')[0]!.toLowerCase()}@${t.domain}`)
            .join(', ')}`,
        );
      }
      for (const n of [...new Set(notes)]) console.log(`  ${n}`);
    }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[seed] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
