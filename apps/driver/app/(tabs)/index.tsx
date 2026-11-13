import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { Badge, Button, C, Card, H, Muted, s } from '@/components/ui';
import { api, onOutbox, readOutbox } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { isTracking, pendingPositions, startTracking, stopTracking } from '@/lib/tracking';

const time = (v: string | null | undefined): string => (v ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

export default function HomeTab(): ReactNode {
  const { t } = useLang();
  const { home, refreshHome } = useSession();
  const [tracking, setTracking] = useState(false);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api.get<{ data: Record<string, unknown>[] }>('/jobs/my/current') });
  useEffect(() => {
    void isTracking().then(setTracking);
    void readOutbox().then((o) => setPending(o.length));
    const off = onOutbox(setPending);
    const id = setInterval(() => void pendingPositions().then((n) => n > 0 && setPending((p) => Math.max(p, 0))), 30_000);
    return () => { off(); clearInterval(id); };
  }, []);
  if (!home) return <View style={s.screen} />;
  const d = home.driver;
  const sh = home.shift;
  const onShift = sh?.status === 'in_progress' || Boolean(sh?.actual_start && !sh?.actual_end);

  const toggleShift = async (): Promise<void> => {
    if (!sh) return;
    setBusy(true);
    try {
      if (!onShift) {
        await api.post(`/shifts/${sh.id}/start`);
        const r = await startTracking();
        if (!r.ok) Alert.alert('Location', r.reason ?? '');
        setTracking(await isTracking());
      } else {
        await api.post(`/shifts/${sh.id}/end`);
        await stopTracking();
        setTracking(false);
      }
      refreshHome();
    } catch (e) {
      Alert.alert('Shift', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const active = (jobs.data?.data ?? []).filter((j) => j.status === 'dispatched' || j.status === 'in_progress');
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={jobs.isRefetching} onRefresh={() => { refreshHome(); void jobs.refetch(); }} />}>
      <H style={{ fontSize: 22 }}>{t('hello')}, {d.full_name.split(' ')[0]} 👋</H>
      {pending > 0 && <Badge tone="amber" text={`${pending} ${t('pending_sync')}`} />}
      <Card style={{ marginTop: 12 }}>
        <Muted>{t('your_vehicle')}</Muted>
        {d.plate_number ? (
          <>
            <Text style={{ fontSize: 24, fontWeight: '800', color: C.ink, marginTop: 2 }}>{d.plate_number}</Text>
            <Muted>{[d.vehicle_label, d.odometer_km ? `${Math.round(Number(d.odometer_km)).toLocaleString()} km` : null].filter(Boolean).join(' · ')}</Muted>
            <View style={[s.row, { marginTop: 10, gap: 8 }]}>
              <Ionicons name={d.has_hardware || tracking ? 'radio' : 'radio-outline'} size={16} color={d.has_hardware || tracking ? C.green : C.muted} />
              <Muted>{d.has_hardware ? t('tracking_hw') : tracking ? t('tracking_on') : 'Location sharing off'}</Muted>
            </View>
          </>
        ) : <Text style={{ color: C.amber, marginTop: 4 }}>{t('no_vehicle')}</Text>}
      </Card>
      <Card>
        <Muted>{t('shift')}</Muted>
        {sh ? (
          <>
            <Text style={{ fontSize: 18, fontWeight: '700', marginTop: 2 }}>{time(sh.starts_at)} – {time(sh.ends_at)}{sh.plate_number ? ` · ${sh.plate_number}` : ''}</Text>
            <Button title={onShift ? t('end_shift') : t('start_shift')} variant={onShift ? 'secondary' : 'primary'} loading={busy} onPress={() => void toggleShift()} style={{ marginTop: 12 }} />
          </>
        ) : <Muted style={{ marginTop: 4 }}>{t('no_shift')}</Muted>}
      </Card>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
        <Action icon="clipboard" label={t('pre_trip')} onPress={() => router.push('/inspection')} disabled={!d.vehicle_id} />
        <Action icon="water" label={t('fuel')} onPress={() => router.push('/fuel')} disabled={!d.vehicle_id} />
        <Action icon="warning" label={t('report_defect')} onPress={() => router.push('/defect')} disabled={!d.vehicle_id} />
      </View>
      <H>{t('active_jobs')}</H>
      {active.map((j) => (
        <Pressable key={String(j.id)} onPress={() => router.push(`/job/${String(j.id)}`)}>
          <Card>
            <View style={[s.row, { justifyContent: 'space-between' }]}>
              <Text style={{ fontSize: 16, fontWeight: '700', flex: 1 }}>{String(j.title)}</Text>
              <Badge status={String(j.status)} text={t(String(j.status))} />
            </View>
            <Muted>{String(j.reference)} · {String(j.stops_done)}/{String(j.stop_count)} {t('stops').toLowerCase()}{j.next_eta ? ` · ${t('eta')} ${time(String(j.next_eta))}` : ''}</Muted>
          </Card>
        </Pressable>
      ))}
      {!active.length && <Muted>{t('no_jobs')}</Muted>}
    </ScrollView>
  );
}

function Action({ icon, label, onPress, disabled }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; disabled?: boolean }): ReactNode {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [{ flex: 1, backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 12, alignItems: 'center', gap: 6, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}>
      <Ionicons name={icon} size={24} color={C.brand} />
      <Text style={{ fontSize: 12, fontWeight: '600', textAlign: 'center', color: C.ink }}>{label}</Text>
    </Pressable>
  );
}
