import * as Localization from 'expo-localization';
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Lang = 'en' | 'sw';
const dict: Record<string, { en: string; sw: string }> = {
  sign_in: { en: 'Sign in', sw: 'Ingia' },
  email: { en: 'Email', sw: 'Barua pepe' },
  password: { en: 'Password', sw: 'Nenosiri' },
  home: { en: 'Home', sw: 'Mwanzo' },
  jobs: { en: 'Jobs', sw: 'Kazi' },
  messages: { en: 'Messages', sw: 'Ujumbe' },
  more: { en: 'More', sw: 'Zaidi' },
  hello: { en: 'Hello', sw: 'Habari' },
  your_vehicle: { en: 'Your vehicle', sw: 'Gari lako' },
  no_vehicle: { en: 'No vehicle assigned - ask your fleet manager', sw: 'Hujapewa gari - wasiliana na msimamizi' },
  shift: { en: 'Shift', sw: 'Zamu' },
  start_shift: { en: 'Start shift', sw: 'Anza zamu' },
  end_shift: { en: 'End shift', sw: 'Maliza zamu' },
  no_shift: { en: 'No shift scheduled', sw: 'Hakuna zamu iliyopangwa' },
  tracking_on: { en: 'Location sharing on', sw: 'Eneo linashirikiwa' },
  tracking_hw: { en: 'Tracked by the vehicle GPS unit', sw: 'Linafuatiliwa na kifaa cha GPS cha gari' },
  pre_trip: { en: 'Pre-trip inspection', sw: 'Ukaguzi kabla ya safari' },
  fuel: { en: 'Log fuel', sw: 'Rekodi mafuta' },
  report_defect: { en: 'Report a problem', sw: 'Ripoti tatizo' },
  active_jobs: { en: 'Active jobs', sw: 'Kazi zinazoendelea' },
  no_jobs: { en: 'No jobs right now', sw: 'Hakuna kazi kwa sasa' },
  stops: { en: 'Stops', sw: 'Vituo' },
  navigate: { en: 'Navigate', sw: 'Elekeza' },
  call: { en: 'Call', sw: 'Piga simu' },
  arrived: { en: 'Arrived', sw: 'Nimefika' },
  complete: { en: 'Complete', sw: 'Kamilisha' },
  failed: { en: 'Could not deliver', sw: 'Imeshindikana' },
  start_job: { en: 'Start job', sw: 'Anza kazi' },
  proof: { en: 'Proof of delivery', sw: 'Uthibitisho wa kufikisha' },
  recipient: { en: 'Received by', sw: 'Amepokea' },
  phone: { en: 'Phone', sw: 'Simu' },
  photos: { en: 'Photos', sw: 'Picha' },
  take_photo: { en: 'Take photo', sw: 'Piga picha' },
  signature: { en: 'Signature', sw: 'Sahihi' },
  clear: { en: 'Clear', sw: 'Futa' },
  save: { en: 'Save', sw: 'Hifadhi' },
  cancel: { en: 'Cancel', sw: 'Ghairi' },
  submit: { en: 'Submit', sw: 'Wasilisha' },
  reason: { en: 'Reason', sw: 'Sababu' },
  notes: { en: 'Notes', sw: 'Maelezo' },
  litres: { en: 'Litres', sw: 'Lita' },
  amount: { en: 'Amount paid', sw: 'Kiasi kilicholipwa' },
  odometer: { en: 'Odometer (km)', sw: 'Odometa (km)' },
  station: { en: 'Station', sw: 'Kituo' },
  receipt: { en: 'Receipt photo', sw: 'Picha ya risiti' },
  full_tank: { en: 'Filled to full', sw: 'Tangi limejaa' },
  ok: { en: 'OK', sw: 'Sawa' },
  defect: { en: 'Problem', sw: 'Tatizo' },
  na: { en: 'N/A', sw: 'Haihusiki' },
  queued: { en: 'Saved - will send when you are back online', sw: 'Imehifadhiwa - itatumwa ukipata mtandao' },
  sent: { en: 'Sent', sw: 'Imetumwa' },
  pending_sync: { en: 'waiting to sync', sw: 'zinasubiri kutumwa' },
  type_message: { en: 'Message dispatch…', sw: 'Andika ujumbe…' },
  language: { en: 'Language', sw: 'Lugha' },
  sign_out: { en: 'Sign out', sw: 'Toka' },
  severity: { en: 'How serious?', sw: 'Ni kubwa kiasi gani?' },
  minor: { en: 'Minor', sw: 'Ndogo' },
  major: { en: 'Major', sw: 'Kubwa' },
  critical: { en: 'Unsafe to drive', sw: 'Si salama kuendesha' },
  title: { en: 'What is wrong?', sw: 'Nini kimeharibika?' },
  pickup: { en: 'Pickup', sw: 'Kuchukua' },
  delivery: { en: 'Delivery', sw: 'Kufikisha' },
  service: { en: 'Service', sw: 'Huduma' },
  waypoint: { en: 'Waypoint', sw: 'Kituo cha njiani' },
  pending: { en: 'Pending', sw: 'Inasubiri' },
  en_route: { en: 'En route', sw: 'Njiani' },
  completed: { en: 'Done', sw: 'Imekamilika' },
  skipped: { en: 'Skipped', sw: 'Imerukwa' },
  dispatched: { en: 'New', sw: 'Mpya' },
  in_progress: { en: 'In progress', sw: 'Inaendelea' },
  scheduled: { en: 'Scheduled', sw: 'Imepangwa' },
  eta: { en: 'ETA', sw: 'Muda wa kufika' },
  by: { en: 'by', sw: 'kabla ya' },
  inspection_done: { en: 'Inspection submitted', sw: 'Ukaguzi umewasilishwa' },
  all_ok: { en: 'Mark all OK', sw: 'Zote ziko sawa' },
};

let lang: Lang = (Localization.getLocales()[0]?.languageCode === 'sw' ? 'sw' : 'en');
const subs = new Set<() => void>();
void AsyncStorage.getItem('jfs.lang').then((l) => {
  if (l === 'en' || l === 'sw') setLang(l);
});
export function setLang(l: Lang): void {
  lang = l;
  void AsyncStorage.setItem('jfs.lang', l);
  subs.forEach((s) => s());
}
export const t = (k: string): string => dict[k]?.[lang] ?? k.replace(/_/g, ' ');
export function useLang(): { lang: Lang; t: (k: string) => string } {
  const l = useSyncExternalStore((cb) => {
    subs.add(cb);
    return () => subs.delete(cb);
  }, () => lang);
  return { lang: l, t };
}
