export type Locale = 'en' | 'sw';
export interface AlertText {
  title: string;
  message: string;
}
export interface TemplateData {
  plate: string;
  driver?: string | null;
  speed?: number | null;
  value?: number | null;
  limit?: number | null;
  place?: string | null;
  geofence?: string | null;
  time: string;
  extra?: string | null;
}

type T = (d: TemplateData) => AlertText;
const where = (d: TemplateData, sw = false): string =>
  d.place ? (sw ? ` karibu na ${d.place}` : ` near ${d.place}`) : '';
const who = (d: TemplateData, sw = false): string =>
  d.driver ? (sw ? ` (dereva: ${d.driver})` : ` (driver: ${d.driver})`) : '';
const mins = (s: number | null | undefined): number => Math.round((s ?? 0) / 60);

const EN: Record<string, T> = {
  overspeed: (d) => ({
    title: `Overspeeding: ${d.plate}`,
    message: `${d.plate} reached ${d.speed} km/h${d.limit ? ` (limit ${d.limit})` : ''}${where(d)} at ${d.time}${who(d)}.`,
  }),
  harsh_brake: (d) => ({
    title: `Harsh braking: ${d.plate}`,
    message: `${d.plate} braked harshly${where(d)} at ${d.time}${who(d)}.`,
  }),
  harsh_accel: (d) => ({
    title: `Harsh acceleration: ${d.plate}`,
    message: `${d.plate} accelerated harshly${where(d)} at ${d.time}${who(d)}.`,
  }),
  harsh_corner: (d) => ({
    title: `Sharp cornering: ${d.plate}`,
    message: `${d.plate} cornered sharply${where(d)} at ${d.time}${who(d)}.`,
  }),
  excessive_idle: (d) => ({
    title: `Excessive idling: ${d.plate}`,
    message: `${d.plate} has been idling for ${mins(d.value)} minutes${where(d)}.`,
  }),
  night_driving: (d) => ({
    title: `Night driving: ${d.plate}`,
    message: `${d.plate} is driving at night (${d.time})${who(d)}.`,
  }),
  sos: (d) => ({
    title: `SOS from ${d.plate}`,
    message: `PANIC BUTTON pressed in ${d.plate}${where(d)} at ${d.time}${who(d)}. Respond immediately.`,
  }),
  crash: (d) => ({
    title: `Possible crash: ${d.plate}`,
    message: `A crash was detected on ${d.plate}${where(d)} at ${d.time}${who(d)}. Contact the driver now.`,
  }),
  towing: (d) => ({
    title: `Towing detected: ${d.plate}`,
    message: `${d.plate} is moving with the ignition off${where(d)} at ${d.time}.`,
  }),
  tamper: (d) => ({
    title: `Tracker tampering: ${d.plate}`,
    message: `Signal jamming or tampering detected on ${d.plate}${where(d)} at ${d.time}.`,
  }),
  power_cut: (d) => ({
    title: `Tracker power cut: ${d.plate}`,
    message: `The tracker on ${d.plate} lost external power${where(d)} at ${d.time}.`,
  }),
  low_battery: (d) => ({
    title: `Tracker battery low: ${d.plate}`,
    message: `The tracker backup battery on ${d.plate} is low.`,
  }),
  device_offline: (d) => ({
    title: `Tracker offline: ${d.plate}`,
    message: `${d.plate} has not reported since ${d.time}${where(d)}.`,
  }),
  geofence_enter: (d) => ({
    title: `${d.plate} entered ${d.geofence}`,
    message: `${d.plate} entered ${d.geofence} at ${d.time}${who(d)}.`,
  }),
  geofence_exit: (d) => ({
    title: `${d.plate} left ${d.geofence}`,
    message: `${d.plate} left ${d.geofence} at ${d.time}${d.value ? ` after ${mins(d.value)} minutes` : ''}${who(d)}.`,
  }),
  geofence_dwell: (d) => ({
    title: `${d.plate} staying in ${d.geofence}`,
    message: `${d.plate} has been in ${d.geofence} for ${mins(d.value)} minutes.`,
  }),
  ignition_on: (d) => ({
    title: `Ignition on: ${d.plate}`,
    message: `${d.plate} was started at ${d.time}${where(d)}${who(d)}.`,
  }),
  ignition_off: (d) => ({
    title: `Ignition off: ${d.plate}`,
    message: `${d.plate} was switched off at ${d.time}${where(d)}.`,
  }),
  after_hours_use: (d) => ({
    title: `After-hours use: ${d.plate}`,
    message: `${d.plate} was started outside working hours at ${d.time}${where(d)}${who(d)}.`,
  }),
  fuel_drain: (d) => ({
    title: `Possible fuel theft: ${d.plate}`,
    message: `Fuel dropped by ${d.value} L on ${d.plate}${where(d)} at ${d.time}.`,
  }),
  refuel: (d) => ({
    title: `Refuel: ${d.plate}`,
    message: `${d.plate} was refuelled with ${d.value} L${where(d)} at ${d.time}.`,
  }),
  fuel_level_low: (d) => ({
    title: `Low fuel: ${d.plate}`,
    message: `${d.plate} fuel level is ${d.value}%.`,
  }),
  dtc: (d) => ({
    title: `Engine fault: ${d.plate}`,
    message: `Fault code ${d.extra} reported by ${d.plate}.`,
  }),
  service_due: (d) => ({
    title: `Service reminder: ${d.plate}`,
    message: `${d.plate}: ${d.extra}.`,
  }),
  document_expiry: (d) => ({
    title: `Document expiring: ${d.plate}`,
    message: `${d.plate}: ${d.extra}.`,
  }),
  licence_expiry: (d) => ({
    title: `Licence expiring: ${d.driver}`,
    message: `${d.driver}: ${d.extra}.`,
  }),
  unauthorized_driver: (d) => ({
    title: `Unauthorised driver: ${d.plate}`,
    message: `${d.plate} was started with an unknown or unauthorised driver tag${d.extra ? ` (${d.extra})` : ''}.`,
  }),
  route_deviation: (d) => ({
    title: `Route deviation: ${d.plate}`,
    message: `${d.plate} is ${d.value} m off the planned route${d.extra ? ` for job ${d.extra}` : ''}.`,
  }),
  job_late: (d) => ({
    title: `Job running late: ${d.extra}`,
    message: `${d.plate} is expected to miss the time window for ${d.extra}.`,
  }),
  inspection_failed: (d) => ({
    title: `Inspection failed: ${d.plate}`,
    message: `${d.plate} failed its ${d.extra ?? ''} inspection${who(d)}.`,
  }),
  defect_critical: (d) => ({
    title: `Critical defect: ${d.plate}`,
    message: `Critical defect reported on ${d.plate}: ${d.extra}.`,
  }),
};

const SW: Record<string, T> = {
  overspeed: (d) => ({
    title: `Mwendo kasi: ${d.plate}`,
    message: `${d.plate} imefikia km/h ${d.speed}${d.limit ? ` (kikomo ${d.limit})` : ''}${where(d, true)} saa ${d.time}${who(d, true)}.`,
  }),
  harsh_brake: (d) => ({
    title: `Breki ya ghafla: ${d.plate}`,
    message: `${d.plate} imefunga breki ghafla${where(d, true)} saa ${d.time}${who(d, true)}.`,
  }),
  harsh_accel: (d) => ({
    title: `Kuongeza kasi ghafla: ${d.plate}`,
    message: `${d.plate} imeongeza kasi ghafla${where(d, true)} saa ${d.time}${who(d, true)}.`,
  }),
  harsh_corner: (d) => ({
    title: `Kona kali: ${d.plate}`,
    message: `${d.plate} imekata kona kwa kasi${where(d, true)} saa ${d.time}${who(d, true)}.`,
  }),
  excessive_idle: (d) => ({
    title: `Injini imewashwa bila kutembea: ${d.plate}`,
    message: `${d.plate} imesimama injini ikiwa imewashwa kwa dakika ${mins(d.value)}${where(d, true)}.`,
  }),
  night_driving: (d) => ({
    title: `Kuendesha usiku: ${d.plate}`,
    message: `${d.plate} inaendeshwa usiku (${d.time})${who(d, true)}.`,
  }),
  sos: (d) => ({
    title: `SOS kutoka ${d.plate}`,
    message: `KITUFE CHA DHARURA kimebonyezwa ndani ya ${d.plate}${where(d, true)} saa ${d.time}${who(d, true)}. Chukua hatua sasa.`,
  }),
  crash: (d) => ({
    title: `Huenda ni ajali: ${d.plate}`,
    message: `Ajali imegunduliwa kwa ${d.plate}${where(d, true)} saa ${d.time}${who(d, true)}. Mpigie dereva sasa.`,
  }),
  towing: (d) => ({
    title: `Gari linavutwa: ${d.plate}`,
    message: `${d.plate} inasogea ikiwa imezimwa${where(d, true)} saa ${d.time}.`,
  }),
  tamper: (d) => ({
    title: `Kifaa kinachezewa: ${d.plate}`,
    message: `Uingiliaji wa mawimbi umegunduliwa kwa ${d.plate}${where(d, true)} saa ${d.time}.`,
  }),
  power_cut: (d) => ({
    title: `Umeme wa kifaa umekatwa: ${d.plate}`,
    message: `Kifaa cha ufuatiliaji cha ${d.plate} kimepoteza umeme${where(d, true)} saa ${d.time}.`,
  }),
  low_battery: (d) => ({
    title: `Betri ya kifaa iko chini: ${d.plate}`,
    message: `Betri ya akiba ya kifaa cha ${d.plate} iko chini.`,
  }),
  device_offline: (d) => ({
    title: `Kifaa hakipatikani: ${d.plate}`,
    message: `${d.plate} haijatuma taarifa tangu ${d.time}${where(d, true)}.`,
  }),
  geofence_enter: (d) => ({
    title: `${d.plate} imeingia ${d.geofence}`,
    message: `${d.plate} imeingia ${d.geofence} saa ${d.time}${who(d, true)}.`,
  }),
  geofence_exit: (d) => ({
    title: `${d.plate} imetoka ${d.geofence}`,
    message: `${d.plate} imetoka ${d.geofence} saa ${d.time}${d.value ? ` baada ya dakika ${mins(d.value)}` : ''}${who(d, true)}.`,
  }),
  geofence_dwell: (d) => ({
    title: `${d.plate} imekaa ${d.geofence}`,
    message: `${d.plate} imekaa ndani ya ${d.geofence} kwa dakika ${mins(d.value)}.`,
  }),
  ignition_on: (d) => ({
    title: `Gari limewashwa: ${d.plate}`,
    message: `${d.plate} imewashwa saa ${d.time}${where(d, true)}${who(d, true)}.`,
  }),
  ignition_off: (d) => ({
    title: `Gari limezimwa: ${d.plate}`,
    message: `${d.plate} imezimwa saa ${d.time}${where(d, true)}.`,
  }),
  after_hours_use: (d) => ({
    title: `Matumizi nje ya saa za kazi: ${d.plate}`,
    message: `${d.plate} imewashwa nje ya saa za kazi saa ${d.time}${where(d, true)}${who(d, true)}.`,
  }),
  fuel_drain: (d) => ({
    title: `Huenda mafuta yameibwa: ${d.plate}`,
    message: `Mafuta yamepungua lita ${d.value} kwa ${d.plate}${where(d, true)} saa ${d.time}.`,
  }),
  refuel: (d) => ({
    title: `Kujaza mafuta: ${d.plate}`,
    message: `${d.plate} imejazwa lita ${d.value}${where(d, true)} saa ${d.time}.`,
  }),
  fuel_level_low: (d) => ({
    title: `Mafuta yako chini: ${d.plate}`,
    message: `Kiwango cha mafuta cha ${d.plate} ni ${d.value}%.`,
  }),
  dtc: (d) => ({
    title: `Hitilafu ya injini: ${d.plate}`,
    message: `Msimbo wa hitilafu ${d.extra} umeripotiwa na ${d.plate}.`,
  }),
  service_due: (d) => ({
    title: `Kikumbusho cha huduma: ${d.plate}`,
    message: `${d.plate}: ${d.extra}.`,
  }),
  document_expiry: (d) => ({
    title: `Hati inaisha: ${d.plate}`,
    message: `${d.plate}: ${d.extra}.`,
  }),
  licence_expiry: (d) => ({
    title: `Leseni inaisha: ${d.driver}`,
    message: `${d.driver}: ${d.extra}.`,
  }),
  unauthorized_driver: (d) => ({
    title: `Dereva asiyeidhinishwa: ${d.plate}`,
    message: `${d.plate} imewashwa na dereva asiyejulikana${d.extra ? ` (${d.extra})` : ''}.`,
  }),
  route_deviation: (d) => ({
    title: `Kupotoka njia: ${d.plate}`,
    message: `${d.plate} iko mita ${d.value} nje ya njia iliyopangwa${d.extra ? ` kwa kazi ${d.extra}` : ''}.`,
  }),
  job_late: (d) => ({
    title: `Kazi imechelewa: ${d.extra}`,
    message: `${d.plate} huenda ikachelewa kwa ${d.extra}.`,
  }),
  inspection_failed: (d) => ({
    title: `Ukaguzi umeshindwa: ${d.plate}`,
    message: `${d.plate} imeshindwa ukaguzi${who(d, true)}.`,
  }),
  defect_critical: (d) => ({
    title: `Hitilafu kubwa: ${d.plate}`,
    message: `Hitilafu kubwa imeripotiwa kwa ${d.plate}: ${d.extra}.`,
  }),
};

export function render(type: string, locale: Locale, d: TemplateData): AlertText {
  const t = (locale === 'sw' ? SW : EN)[type] ?? EN[type];
  return t
    ? t(d)
    : {
        title: `${type.replace(/_/g, ' ')}: ${d.plate}`,
        message: `${type.replace(/_/g, ' ')} on ${d.plate} at ${d.time}.`,
      };
}
