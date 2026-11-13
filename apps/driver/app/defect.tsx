import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Button, C, Field, H, Muted, Segmented, s } from '@/components/ui';
import { sendOrQueue } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { takePhoto } from '@/lib/photo';
import { useSession } from '@/lib/session';

export default function Defect(): ReactNode {
  const { t } = useLang();
  const { home, refreshHome } = useSession();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<'minor' | 'major' | 'critical'>('major');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (!home?.driver.vehicle_id) return <View style={[s.screen, { padding: 16 }]}><Muted>{t('no_vehicle')}</Muted></View>;
  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const sent = await sendOrQueue({ method: 'POST', path: '/defects', body: { vehicle_id: home.driver.vehicle_id, title, description: description || null, severity }, files: photos.length ? [{ field: 'photo_file_ids', uris: photos, purpose: 'inspection' }] : [], label: `defect ${title}` });
      Alert.alert('', sent ? t('sent') : t('queued'));
      refreshHome();
      router.back();
    } catch (e) {
      Alert.alert('', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <H>{home.driver.plate_number}</H>
      <Field label={t('title')} value={title} onChangeText={setTitle} placeholder="e.g. Brakes squealing" />
      <Field label={t('notes')} value={description} onChangeText={setDescription} multiline />
      <Text style={s.label}>{t('severity')}</Text>
      <Segmented value={severity} onChange={setSeverity} options={[{ value: 'minor', label: t('minor'), color: C.muted }, { value: 'major', label: t('major'), color: C.amber }, { value: 'critical', label: t('critical'), color: C.red }]} />
      <View style={[s.row, { gap: 8, marginVertical: 14, flexWrap: 'wrap' }]}>
        {photos.map((p) => <Image key={p} source={{ uri: p }} style={{ width: 72, height: 72, borderRadius: 10 }} />)}
        <Pressable onPress={async () => { const p = await takePhoto(); if (p) setPhotos((x) => [...x, p]); }} style={{ padding: 12 }}><Text style={{ color: C.brand, fontWeight: '600' }}>+ {t('take_photo')}</Text></Pressable>
      </View>
      <Button title={t('submit')} loading={busy} disabled={title.trim().length < 2} onPress={() => void submit()} />
    </ScrollView>
  );
}
