import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Button, C, Card, H, Muted, Segmented, s } from '@/components/ui';
import { flushOutbox, onOutbox, readOutbox, type OutboxItem } from '@/lib/api';
import { setLang, useLang } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { pendingPositions, stopTracking } from '@/lib/tracking';
import Constants from 'expo-constants';

export default function MoreTab(): ReactNode {
  const { t, lang } = useLang();
  const { home, signOut } = useSession();
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [positions, setPositions] = useState(0);
  useEffect(() => {
    const load = (): void => { void readOutbox().then(setOutbox); void pendingPositions().then(setPositions); };
    load();
    return onOutbox(load);
  }, []);
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }}>
      <Card>
        <H>{home?.driver.full_name}</H>
        <Muted>{[home?.driver.employee_number, home?.driver.phone, home?.company.name].filter(Boolean).join(' · ')}</Muted>
      </Card>
      <Card>
        <Text style={s.label}>{t('language')}</Text>
        <Segmented value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'sw', label: 'Kiswahili' }]} />
      </Card>
      <Card>
        <Text style={s.label}>Sync</Text>
        <Text style={{ color: C.ink }}>{outbox.length} actions · {positions} positions {t('pending_sync')}</Text>
        {outbox.slice(0, 5).map((o) => <Muted key={o.id}>• {o.label}{o.lastError ? ` (${o.lastError})` : ''}</Muted>)}
        <Button small title="Sync now" variant="secondary" style={{ marginTop: 10 }} onPress={() => void flushOutbox().then((n) => Alert.alert('', `${n} ${t('sent').toLowerCase()}`))} />
      </Card>
      <Pressable onPress={() => router.push('/defect')}><Card><Text style={{ fontWeight: '600', color: C.ink }}>{t('report_defect')}</Text></Card></Pressable>
      <Button title={t('sign_out')} variant="danger" onPress={() => Alert.alert(t('sign_out'), '', [{ text: t('cancel') }, { text: t('sign_out'), style: 'destructive', onPress: () => void stopTracking().then(signOut) }])} />
      <View style={{ alignItems: 'center', marginTop: 20 }}><Muted>Jatelo Fleet Driver {Constants.expoConfig?.version} · © Jatelo Technologies</Muted></View>
    </ScrollView>
  );
}
