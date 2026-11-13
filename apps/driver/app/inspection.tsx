import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Button, C, Card, Field, H, Muted, Segmented, s } from '@/components/ui';
import { sendOrQueue } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { takePhoto } from '@/lib/photo';
import { useSession } from '@/lib/session';
import { here } from '@/lib/tracking';

type Status = 'ok' | 'defect' | 'na';

/** Pre-trip / post-trip checklist from the company template. Defects on critical items flag the vehicle unsafe. */
export default function Inspection(): ReactNode {
  const { t, lang } = useLang();
  const { home, refreshHome } = useSession();
  const tpl = home?.inspection_templates.find((x) => x.is_default) ?? home?.inspection_templates[0];
  const [startedAt] = useState(new Date().toISOString());
  const [kind, setKind] = useState<'pre_trip' | 'post_trip'>('pre_trip');
  const [answers, setAnswers] = useState<Record<string, { status: Status; note?: string; photos: string[] }>>({});
  const [odo, setOdo] = useState('');
  const [busy, setBusy] = useState(false);
  if (!home?.driver.vehicle_id || !tpl) return <View style={[s.screen, { padding: 16 }]}><Muted>{t('no_vehicle')}</Muted></View>;
  const set = (id: string, v: Partial<{ status: Status; note: string; photos: string[] }>): void => setAnswers((a) => ({ ...a, [id]: { ...{ status: 'ok' as Status, photos: [] as string[] }, ...a[id], ...v } }));
  const done = tpl.items.every((i) => answers[i.id]);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const pos = await here();
      const results = tpl.items.map((i) => ({ template_item_id: i.id, label: i.label, category: i.category, is_critical: i.is_critical, status: answers[i.id]!.status, note: answers[i.id]!.note || undefined, photo_file_ids: [] as string[] }));
      const files = tpl.items.flatMap((i, k) => (answers[i.id]!.photos.length ? [{ field: `results.${k}.photo_file_ids`, uris: answers[i.id]!.photos, purpose: 'inspection' }] : []));
      const body = { vehicle_id: home.driver.vehicle_id, template_id: tpl.id, inspection_type: kind, started_at: startedAt, odometer_km: odo ? Number(odo) : undefined, ...(pos ?? {}), results };
      const sent = await sendOrQueue({ method: 'POST', path: '/inspections', body, files: files.map((f) => ({ ...f, field: f.field })), label: 'inspection' });
      Alert.alert('', sent ? t('inspection_done') : t('queued'));
      refreshHome();
      router.back();
    } catch (e) {
      Alert.alert('', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }}>
      <H>{home.driver.plate_number} · {tpl.name}</H>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'pre_trip', label: lang === 'sw' ? 'Kabla ya safari' : 'Pre-trip' }, { value: 'post_trip', label: lang === 'sw' ? 'Baada ya safari' : 'Post-trip' }]} />
      <View style={{ height: 12 }} />
      <Field label={t('odometer')} value={odo} onChangeText={setOdo} keyboardType="numeric" />
      <Button small variant="secondary" title={t('all_ok')} onPress={() => setAnswers(Object.fromEntries(tpl.items.map((i) => [i.id, answers[i.id] ?? { status: 'ok' as Status, photos: [] }])))} style={{ marginBottom: 12 }} />
      {tpl.items.map((i) => {
        const a = answers[i.id];
        return (
          <Card key={i.id} style={a?.status === 'defect' ? { borderColor: C.red } : undefined}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: C.ink, marginBottom: 8 }}>{(lang === 'sw' && i.label_sw) || i.label}{i.is_critical ? '  ⚠️' : ''}</Text>
            <Segmented value={a?.status ?? ('' as Status)} onChange={(v) => set(i.id, { status: v })} options={[{ value: 'ok', label: t('ok'), color: C.green }, { value: 'defect', label: t('defect'), color: C.red }, { value: 'na', label: t('na'), color: C.muted }]} />
            {a?.status === 'defect' && (
              <View style={{ marginTop: 10 }}>
                <Field label={t('notes')} value={a.note ?? ''} onChangeText={(v) => set(i.id, { note: v })} />
                <View style={[s.row, { gap: 8 }]}>
                  {a.photos.map((p) => <Image key={p} source={{ uri: p }} style={{ width: 60, height: 60, borderRadius: 8 }} />)}
                  <Pressable onPress={async () => { const p = await takePhoto(); if (p) set(i.id, { photos: [...a.photos, p] }); }} style={{ padding: 10 }}><Text style={{ color: C.brand, fontWeight: '600' }}>+ {t('take_photo')}</Text></Pressable>
                </View>
              </View>
            )}
          </Card>
        );
      })}
      <Button title={t('submit')} disabled={!done} loading={busy} onPress={() => void submit()} style={{ marginBottom: 30 }} />
    </ScrollView>
  );
}
