import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState, type ReactNode } from 'react';
import { Alert, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Button, C, Card, Field, H, Muted, SignaturePad, s } from '@/components/ui';
import { api, sendOrQueue } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { takePhoto } from '@/lib/photo';
import { here } from '@/lib/tracking';

type Row = Record<string, unknown>;
const time = (v: unknown): string => (v ? new Date(String(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export default function JobScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useLang();
  const qc = useQueryClient();
  const [pod, setPod] = useState<Row | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['job', id], queryFn: () => api.get<Row & { stops: Row[] }>(`/jobs/${id}`) });
  const j = q.data;
  const refresh = (): void => {
    void q.refetch();
    void qc.invalidateQueries({ queryKey: ['jobs'] });
  };
  const act = async (stop: Row, action: 'arrive' | 'fail', extra: Row = {}): Promise<void> => {
    setBusy(`${String(stop.id)}${action}`);
    try {
      const pos = await here();
      const sent = await sendOrQueue({ method: 'POST', path: `/jobs/${id}/stops/${String(stop.id)}/${action}`, body: { ...extra, ...(pos ?? {}), at: new Date().toISOString() }, label: `${action} ${String(stop.name)}` });
      if (!sent) Alert.alert('', t('queued'));
      refresh();
    } catch (e) {
      Alert.alert('', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!j) return <View style={s.screen} />;
  const status = String(j.status);
  const canAct = status === 'dispatched' || status === 'in_progress';
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: String(j.reference) }} />
      <H style={{ fontSize: 20, marginBottom: 2 }}>{String(j.title)}</H>
      <Muted>{[j.customer_name, j.customer_phone].filter(Boolean).join(' · ')}</Muted>
      {Boolean(j.notes) && <Card style={{ marginTop: 10, backgroundColor: '#FFFBEB', borderColor: '#F5E2B0' }}><Text>{String(j.notes)}</Text></Card>}
      {status === 'dispatched' && <Button title={t('start_job')} style={{ marginTop: 10 }} loading={busy === 'start'} onPress={async () => {
        setBusy('start');
        try { await api.post(`/jobs/${id}/status`, { status: 'in_progress' }); refresh(); } catch (e) { Alert.alert('', (e as Error).message); } finally { setBusy(null); }
      }} />}
      <H style={{ marginTop: 16 }}>{t('stops')}</H>
      {j.stops.map((st) => {
        const ss = String(st.status);
        const open = ['pending', 'en_route', 'arrived'].includes(ss);
        return (
          <Card key={String(st.id)} style={!open ? { opacity: 0.7 } : undefined}>
            <View style={[s.row, { gap: 10 }]}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: ss === 'completed' ? C.green : ss === 'failed' ? C.red : C.brand, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: C.white, fontWeight: '700' }}>{String(st.seq)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{String(st.name)}</Text>
                <Muted>{t(String(st.stop_type))}{st.time_window_end ? ` · ${t('by')} ${time(st.time_window_end)}` : ''}{st.eta && open ? ` · ${t('eta')} ${time(st.eta)}` : ''}</Muted>
              </View>
              <Badge status={ss} text={t(ss)} />
            </View>
            {Boolean(st.address) && <Muted style={{ marginTop: 6 }}>{String(st.address)}</Muted>}
            {Boolean(st.instructions) && <Text style={{ marginTop: 6, color: C.ink }}>📝 {String(st.instructions)}</Text>}
            <View style={[s.row, { gap: 8, marginTop: 10, flexWrap: 'wrap' }]}>
              <Pill icon="navigate" label={t('navigate')} onPress={() => void Linking.openURL(`google.navigation:q=${String(st.lat)},${String(st.lng)}`).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${String(st.lat)},${String(st.lng)}`))} />
              {Boolean(st.contact_phone) && <Pill icon="call" label={`${t('call')} ${String(st.contact_name ?? '')}`} onPress={() => void Linking.openURL(`tel:${String(st.contact_phone)}`)} />}
            </View>
            {canAct && open && (
              <View style={[s.row, { gap: 8, marginTop: 12 }]}>
                {ss !== 'arrived' && <Button small title={t('arrived')} variant="secondary" style={{ flex: 1 }} loading={busy === `${String(st.id)}arrive`} onPress={() => void act(st, 'arrive')} />}
                <Button small title={t('complete')} style={{ flex: 1 }} onPress={() => setPod(st)} />
                <Button small title={t('failed')} variant="ghost" onPress={() => setPod({ ...st, __fail: true })} />
              </View>
            )}
          </Card>
        );
      })}
      <PodSheet jobId={String(id)} stop={pod} onClose={() => setPod(null)} onDone={() => { setPod(null); refresh(); }} />
    </ScrollView>
  );
}

function Pill({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }): ReactNode {
  return (
    <Pressable onPress={onPress} style={[s.row, { gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: '#EEF5F2' }]}>
      <Ionicons name={icon} size={16} color={C.brand} />
      <Text style={{ color: C.brand, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

/** Completion sheet: recipient, photos and signature (or a failure reason). Works offline - photos upload when back online. */
function PodSheet({ jobId, stop, onClose, onDone }: { jobId: string; stop: Row | null; onClose: () => void; onDone: () => void }): ReactNode {
  const { t } = useLang();
  const fail = Boolean(stop?.__fail);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pad = useRef<{ capture: () => Promise<string | null>; clear: () => void } | null>(null);
  const reset = (): void => { setName(''); setPhone(''); setNotes(''); setPhotos([]); pad.current?.clear(); };
  const submit = async (): Promise<void> => {
    if (!stop) return;
    setBusy(true);
    try {
      const pos = await here();
      if (fail) {
        const sent = await sendOrQueue({ method: 'POST', path: `/jobs/${jobId}/stops/${String(stop.id)}/fail`, body: { reason: notes || 'Not delivered', ...(pos ?? {}), at: new Date().toISOString() }, label: `fail ${String(stop.name)}` });
        if (!sent) Alert.alert('', t('queued'));
      } else {
        const sig = await pad.current?.capture();
        const files = [
          ...(photos.length ? [{ field: 'pod.photo_file_ids', uris: photos, purpose: 'proof_of_delivery' }] : []),
          ...(sig ? [{ field: 'pod.signature_file_id', uris: [sig], purpose: 'proof_of_delivery', contentType: 'image/png', single: true }] : []),
        ];
        const body = { at: new Date().toISOString(), ...(pos ?? {}), ...(name ? { pod: { recipient_name: name, recipient_phone: phone || null, notes: notes || null, photo_file_ids: [], ...(pos ?? {}), captured_at: new Date().toISOString() } } : {}) };
        const sent = await sendOrQueue({ method: 'POST', path: `/jobs/${jobId}/stops/${String(stop.id)}/complete`, body, files: name ? files : [], label: `complete ${String(stop.name)}` });
        if (!sent) Alert.alert('', t('queued'));
      }
      reset();
      onDone();
    } catch (e) {
      Alert.alert('', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={Boolean(stop)} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
          <H>{fail ? t('failed') : t('proof')} · {String(stop?.name ?? '')}</H>
          {fail ? (
            <Field label={t('reason')} value={notes} onChangeText={setNotes} multiline />
          ) : (
            <>
              <Field label={t('recipient')} value={name} onChangeText={setName} />
              <Field label={t('phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
              <Text style={s.label}>{t('photos')}</Text>
              <View style={[s.row, { gap: 8, flexWrap: 'wrap', marginBottom: 14 }]}>
                {photos.map((p) => <Image key={p} source={{ uri: p }} style={{ width: 72, height: 72, borderRadius: 10 }} />)}
                <Pressable onPress={async () => { const p = await takePhoto(); if (p) setPhotos((x) => [...x, p]); }} style={{ width: 72, height: 72, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: '#AAB5B0', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="camera" size={26} color={C.brand} />
                </Pressable>
              </View>
              <View style={[s.row, { justifyContent: 'space-between' }]}>
                <Text style={s.label}>{t('signature')}</Text>
                <Pressable onPress={() => pad.current?.clear()}><Text style={{ color: C.brand, fontWeight: '600' }}>{t('clear')}</Text></Pressable>
              </View>
              <SignaturePad padRef={pad} />
              <View style={{ height: 14 }} />
              <Field label={t('notes')} value={notes} onChangeText={setNotes} multiline />
            </>
          )}
          <View style={[s.row, { gap: 10 }]}>
            <Button title={t('cancel')} variant="secondary" style={{ flex: 1 }} onPress={() => { reset(); onClose(); }} />
            <Button title={fail ? t('submit') : t('complete')} variant={fail ? 'danger' : 'primary'} style={{ flex: 1 }} loading={busy} disabled={fail ? !notes : false} onPress={() => void submit()} />
          </View>
          {!fail && !name && <Muted style={{ marginTop: 10 }}>Leave "received by" empty to complete without proof of delivery.</Muted>}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
