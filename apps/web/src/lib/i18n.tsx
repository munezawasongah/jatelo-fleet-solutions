import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'sw';

/** UI strings. Keys missing in Swahili fall back to English; unknown keys are humanised. */
const sw: Record<string, string> = {
  // navigation
  dashboard: 'Dashibodi', live_map: 'Ramani hai', vehicles: 'Magari', drivers: 'Madereva', devices: 'Vifaa vya GPS', trips: 'Safari',
  geofences: 'Maeneo', places: 'Maeneo muhimu', alerts: 'Tahadhari', alert_rules: 'Sheria za tahadhari', maintenance: 'Matengenezo',
  fuel: 'Mafuta', dispatch: 'Usambazaji', jobs: 'Kazi', routes: 'Njia', messages: 'Ujumbe', reports: 'Ripoti', billing: 'Malipo',
  settings: 'Mipangilio', users: 'Watumiaji', company: 'Kampuni', audit_log: 'Kumbukumbu za ukaguzi', platform: 'Jukwaa', tenants: 'Kampuni wateja',
  plans: 'Vifurushi', invoices: 'Ankara', payments: 'Malipo', shifts: 'Zamu', driver_scores: 'Alama za madereva', webhooks: 'Webhooks',
  vehicle_groups: 'Makundi ya magari', fleet: 'Kundi la magari', operations: 'Uendeshaji', management: 'Usimamizi', admin: 'Utawala',
  // common
  search: 'Tafuta', add: 'Ongeza', new: 'Mpya', edit: 'Hariri', save: 'Hifadhi', cancel: 'Ghairi', delete: 'Futa', close: 'Funga', confirm: 'Thibitisha',
  yes: 'Ndiyo', no: 'Hapana', loading: 'Inapakia…', no_data: 'Hakuna data', actions: 'Vitendo', status: 'Hali', name: 'Jina', from: 'Kutoka', to: 'Hadi',
  today: 'Leo', yesterday: 'Jana', last_7_days: 'Siku 7 zilizopita', last_30_days: 'Siku 30 zilizopita', this_month: 'Mwezi huu', download: 'Pakua',
  run: 'Endesha', back: 'Rudi', next: 'Ifuatayo', previous: 'Iliyotangulia', all: 'Zote', details: 'Maelezo', export: 'Hamisha', refresh: 'Onyesha upya',
  sign_out: 'Toka', sign_in: 'Ingia', email: 'Barua pepe', password: 'Nenosiri', language: 'Lugha', profile: 'Wasifu', security: 'Usalama',
  saved: 'Imehifadhiwa', deleted: 'Imefutwa', are_you_sure: 'Una uhakika?', required: 'Inahitajika', optional: 'Si lazima', none: 'Hakuna',
  page_of: 'Ukurasa {page} kati ya {pages}', results: 'matokeo {n}', send: 'Tuma', type_message: 'Andika ujumbe…', view: 'Tazama',
  // auth
  welcome_back: 'Karibu tena', sign_in_sub: 'Ingia kusimamia magari yako', forgot_password: 'Umesahau nenosiri?', verification_code: 'Nambari ya uthibitisho',
  enter_code: 'Weka nambari ya tarakimu 6 kutoka programu yako ya uthibitisho', reset_password: 'Weka upya nenosiri', new_password: 'Nenosiri jipya',
  accept_invite: 'Kubali mwaliko', set_password: 'Weka nenosiri', reset_link_sent: 'Ikiwa barua pepe ipo, tumetuma kiungo cha kuweka upya.',
  setup_2fa: 'Washa uthibitishaji wa hatua mbili', setup_2fa_sub: 'Akaunti za wasimamizi lazima ziwe na 2FA. Changanua msimbo huu kwa Google Authenticator au Microsoft Authenticator.',
  backup_codes: 'Nambari za akiba', backup_codes_sub: 'Hifadhi nambari hizi mahali salama. Kila moja inatumika mara moja tu.',
  // states
  moving: 'Inaendeshwa', idle: 'Imesimama injini ikiwaka', stopped: 'Imesimama', offline: 'Nje ya mtandao', never: 'Haijaripoti', no_device: 'Haina kifaa',
  open: 'Wazi', acknowledged: 'Imekubaliwa', resolved: 'Imetatuliwa', active: 'Hai', inactive: 'Haifanyi kazi', suspended: 'Imesimamishwa',
  draft: 'Rasimu', scheduled: 'Imepangwa', dispatched: 'Imetumwa', in_progress: 'Inaendelea', completed: 'Imekamilika', cancelled: 'Imeghairiwa', failed: 'Imeshindwa',
  pending: 'Inasubiri', arrived: 'Amefika', skipped: 'Imerukwa', en_route: 'Njiani', paid: 'Imelipwa', overdue: 'Imechelewa', trial: 'Majaribio',
  critical: 'Hatari', warning: 'Onyo', info: 'Taarifa', due: 'Inadaiwa', ok: 'Sawa',
  // dashboard & map
  fleet_status: 'Hali ya magari', distance: 'Umbali', fuel_cost: 'Gharama ya mafuta', driver_score: 'Alama ya dereva', utilisation: 'Matumizi',
  open_alerts: 'Tahadhari wazi', active_jobs: 'Kazi zinazoendelea', services_due: 'Huduma zinazodaiwa', trend_30d: 'Mwenendo wa siku 30',
  top_vehicles: 'Magari yaliyotembea zaidi', best_drivers: 'Madereva bora', needs_coaching: 'Wanaohitaji mafunzo', vs_previous: 'dhidi ya kipindi kilichopita',
  speed: 'Kasi', last_seen: 'Mara ya mwisho', ignition: 'Injini', on: 'Imewashwa', off: 'Imezimwa', driver: 'Dereva', vehicle: 'Gari',
  follow: 'Fuata', playback: 'Rudia safari', share_location: 'Shiriki eneo', history: 'Historia', all_vehicles: 'Magari yote',
  // dispatch
  new_job: 'Kazi mpya', stops: 'Vituo', add_stop: 'Ongeza kituo', optimise: 'Panga njia bora', plan_route: 'Panga njia', dispatch_now: 'Tuma sasa',
  click_map_to_add: 'Bofya ramani kuongeza kituo', proof_of_delivery: 'Uthibitisho wa kufikisha', recipient: 'Mpokeaji', eta: 'Muda wa kufika',
  off_route: 'Nje ya njia', late: 'Imechelewa', customer: 'Mteja', priority: 'Kipaumbele', timeline: 'Mfuatano wa matukio',
  // billing
  current_plan: 'Kifurushi cha sasa', balance_due: 'Salio linalodaiwa', pay_with_mpesa: 'Lipa kwa M-Pesa', mpesa_phone: 'Nambari ya M-Pesa',
  check_phone: 'Angalia simu yako na uweke PIN ya M-Pesa', payment_received: 'Malipo yamepokelewa. Asante!', next_invoice: 'Ankara ijayo',
  vehicles_billed: 'Magari yanayotozwa', change_plan: 'Badilisha kifurushi', per_vehicle_month: 'kwa gari kwa mwezi',
  account_suspended: 'Akaunti ya kampuni imesimamishwa kwa kutolipa. Lipa ankara iliyochelewa ili kuendelea.',
  // reports
  report_type: 'Aina ya ripoti', period: 'Kipindi', scheduled_reports: 'Ripoti zilizopangwa', recipients: 'Wapokeaji', frequency: 'Mara ngapi',
  daily: 'Kila siku', weekly: 'Kila wiki', monthly: 'Kila mwezi', run_report: 'Endesha ripoti', send_now: 'Tuma sasa',
  // misc
  notifications: 'Arifa', mark_all_read: 'Weka zote kama zimesomwa', acknowledge: 'Kubali', resolve: 'Tatua', immobilize: 'Zima injini',
  restore_engine: 'Washa injini tena', send_command: 'Tuma amri', upload: 'Pakia', import: 'Leta', invite_user: 'Alika mtumiaji',
  resend_invite: 'Tuma mwaliko tena', reset_2fa: 'Futa 2FA', role: 'Wadhifa', phone: 'Simu', created: 'Imeundwa', updated: 'Imesasishwa',
  work_orders: 'Maagizo ya kazi', service_schedules: 'Ratiba za huduma', defects: 'Kasoro', parts: 'Vipuri', inspections: 'Ukaguzi',
  fuel_logs: 'Kumbukumbu za mafuta', fuel_events: 'Matukio ya mafuta', fuel_cards: 'Kadi za mafuta', fuel_prices: 'Bei za mafuta',
  service_tasks: 'Kazi za huduma', install_app: 'Sakinisha programu', offline_banner: 'Uko nje ya mtandao - data inaweza kuwa ya zamani',
};

const en: Record<string, string> = {
  live_map: 'Live map', alert_rules: 'Alert rules', audit_log: 'Audit log', driver_scores: 'Driver scores', vehicle_groups: 'Vehicle groups',
  no_data: 'Nothing here yet', are_you_sure: 'Are you sure?', page_of: 'Page {page} of {pages}', results: '{n} results', type_message: 'Type a message…',
  welcome_back: 'Welcome back', sign_in_sub: 'Sign in to manage your fleet', forgot_password: 'Forgot password?',
  enter_code: 'Enter the 6-digit code from your authenticator app', reset_password: 'Reset password', new_password: 'New password',
  accept_invite: 'Accept invitation', set_password: 'Set your password', reset_link_sent: 'If that email exists, we have sent a reset link.',
  setup_2fa: 'Turn on two-step verification', setup_2fa_sub: 'Administrator accounts must use 2FA. Scan this code with Google Authenticator or Microsoft Authenticator.',
  backup_codes: 'Backup codes', backup_codes_sub: 'Store these somewhere safe. Each code works once if you lose your phone.',
  idle: 'Idling', never: 'Never reported', no_device: 'No tracker', in_progress: 'In progress', en_route: 'En route',
  fleet_status: 'Fleet status', fuel_cost: 'Fuel cost', driver_score: 'Driver score', open_alerts: 'Open alerts', active_jobs: 'Active jobs',
  services_due: 'Services due', trend_30d: '30-day trend', top_vehicles: 'Most driven vehicles', best_drivers: 'Best drivers', needs_coaching: 'Needs coaching',
  vs_previous: 'vs previous period', last_seen: 'Last seen', share_location: 'Share location', all_vehicles: 'All vehicles',
  new_job: 'New job', add_stop: 'Add stop', optimise: 'Optimise order', plan_route: 'Plan route', dispatch_now: 'Dispatch now',
  click_map_to_add: 'Click the map to add a stop', proof_of_delivery: 'Proof of delivery', eta: 'ETA', off_route: 'Off route',
  current_plan: 'Current plan', balance_due: 'Balance due', pay_with_mpesa: 'Pay with M-Pesa', mpesa_phone: 'M-Pesa number',
  check_phone: 'Check your phone and enter your M-Pesa PIN', payment_received: 'Payment received. Thank you!', next_invoice: 'Next invoice',
  vehicles_billed: 'Billable vehicles', change_plan: 'Change plan', per_vehicle_month: 'per vehicle / month',
  account_suspended: 'Your company account is suspended for non-payment. Settle the overdue invoice to continue.',
  report_type: 'Report', scheduled_reports: 'Scheduled reports', run_report: 'Run report', send_now: 'Send now', mark_all_read: 'Mark all read',
  immobilize: 'Immobilise engine', restore_engine: 'Restore engine', send_command: 'Send command', invite_user: 'Invite user', resend_invite: 'Resend invite',
  reset_2fa: 'Reset 2FA', work_orders: 'Work orders', service_schedules: 'Service schedules', fuel_logs: 'Fuel logs', fuel_events: 'Fuel events',
  fuel_cards: 'Fuel cards', fuel_prices: 'Fuel prices', service_tasks: 'Service tasks', install_app: 'Install app',
  offline_banner: 'You are offline - data may be out of date', last_7_days: 'Last 7 days', last_30_days: 'Last 30 days', this_month: 'This month',
  sign_out: 'Sign out', sign_in: 'Sign in',
};

/** Field labels (form + table headers). */
const fieldsSw: Record<string, string> = {
  plate_number: 'Nambari ya usajili', fleet_number: 'Nambari ya kundi', label: 'Lebo', make: 'Muundaji', model: 'Modeli', year: 'Mwaka', color: 'Rangi',
  body_type: 'Aina ya bodi', usage_type: 'Matumizi', fuel_type: 'Aina ya mafuta', tank_capacity_l: 'Ujazo wa tangi (L)', odometer_km: 'Odometa (km)',
  engine_hours: 'Saa za injini', group_id: 'Kundi', full_name: 'Jina kamili', employee_number: 'Nambari ya mfanyakazi', national_id: 'Kitambulisho',
  date_of_birth: 'Tarehe ya kuzaliwa', hire_date: 'Tarehe ya kuajiriwa', address: 'Anwani', notes: 'Maelezo', description: 'Maelezo', vehicle_id: 'Gari',
  driver_id: 'Dereva', litres: 'Lita', total_cost: 'Gharama', unit_price: 'Bei kwa lita', filled_at: 'Muda wa kujaza', station_name: 'Kituo',
  title: 'Kichwa', severity: 'Uzito', priority: 'Kipaumbele', scheduled_for: 'Imepangwa', starts_at: 'Inaanza', ends_at: 'Inaisha', category: 'Kundi',
  radius_m: 'Kipenyo (m)', speed_limit_kph: 'Kikomo cha kasi (km/h)', occurred_at: 'Muda', created_at: 'Imeundwa', expires_on: 'Inaisha',
};

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, vars?: Record<string, string | number>) => string; f: (field: string) => string };
const I18n = createContext<Ctx | null>(null);

export const humanize = (k: string): string =>
  k.replace(/_id$/, '').replace(/_ids$/, 's').replace(/_kph$/, ' (km/h)').replace(/_km$/, ' (km)').replace(/_l$/, ' (L)').replace(/_m$/, ' (m)')
    .replace(/_pct$/, ' (%)').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }): ReactNode {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const s = localStorage.getItem('jfs.lang');
      if (s === 'en' || s === 'sw') return s;
    } catch {
      /* storage unavailable */
    }
    return initial ?? (navigator.language.startsWith('sw') ? 'sw' : 'en');
  });
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem('jfs.lang', l);
    } catch {
      /* ignore */
    }
  }, []);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = (lang === 'sw' ? sw[key] : undefined) ?? en[key] ?? humanize(key);
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    },
    [lang],
  );
  const f = useCallback((field: string) => (lang === 'sw' ? fieldsSw[field] : undefined) ?? humanize(field), [lang]);
  const value = useMemo(() => ({ lang, setLang, t, f }), [lang, setLang, t, f]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18n);
  if (!c) throw new Error('I18nProvider missing');
  return c;
}
