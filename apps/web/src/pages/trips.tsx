import { useState, type ReactNode } from 'react';
import { RefSelect } from '../components/forms';
import { PageHeader, Field, Input } from '../components/ui';
import { isoDay } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { TripList } from './vehicles';

export default function TripsPage(): ReactNode {
  const { t } = useI18n();
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [driver, setDriver] = useState<string | null>(null);
  const [from, setFrom] = useState(isoDay(new Date(), -6));
  const [to, setTo] = useState(isoDay());
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader title={t('trips')} subtitle="Every journey detected from ignition and movement. Click a trip to replay it." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={t('vehicle')}><div className="w-52"><RefSelect field="vehicle_id" value={vehicle} onChange={setVehicle} placeholder={t('all_vehicles')} /></div></Field>
        <Field label={t('driver')}><div className="w-52"><RefSelect field="driver_id" value={driver} onChange={setDriver} placeholder={t('all')} /></div></Field>
        <Field label={t('from')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('to')}><Input type="date" value={to} max={isoDay()} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <TripList params={{ vehicle_id: vehicle ?? undefined, driver_id: driver ?? undefined, from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() }} />
    </div>
  );
}
