import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Image, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { Button, C, Field, H, Muted, s } from '@/components/ui';
import { sendOrQueue } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { takePhoto } from '@/lib/photo';
import { useSession } from '@/lib/session';
import { here } from '@/lib/tracking';

export default function Fuel(): ReactNode {
  const { t } = useLang();
  const { home } = useSession();
  const [litres, setLitres] = useState('');
  const [amount, setAmount] = useState('');
  const [odo, setOdo] = useState('');
  const [station, setStation] = useState('');
  const [receiptNo, setReceiptNo] = useState('');
  const [full, setFull] = useState(true);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!home?.driver.vehicle_id) return <View style={[s.screen, { padding: 16 }]}><Muted>{t('no_vehicle')}</Muted></View>;
  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const pos = await here();
      const body = {
        vehicle_id: home.driver.vehicle_id, filled_at: new Date().toISOString(), litres: Number(litres), total_cost: amount ? Number(amount) : undefined,
        odometer_km: odo ? Number(odo) : undefined, is_full_tank: full, station_name: station || undefined, receipt_number: receiptNo || undefined, ...(pos ?? {}),
        client_ref: Crypto.randomUUID(),
      };
      const sent = await sendOrQueue({ method: 'POST', path: '/fuel-logs/submit', body, files: receipt ? [{ field: 'receipt_file_id', uris: [receipt], purpose: 'fuel_receipt', single: true }] : [], label: `fuel ${litres} L` });
      Alert.alert('', sent ? t('sent') : t('queued'));
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
      <Field label={t('litres')} value={litres} onChangeText={setLitres} keyboardType="decimal-pad" />
      <Field label={`${t('amount')} (${home.company.currency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <Field label={t('odometer')} value={odo} onChangeText={setOdo} keyboardType="numeric" placeholder={home.driver.odometer_km ? String(Math.round(Number(home.driver.odometer_km))) : undefined} />
      <Field label={t('station')} value={station} onChangeText={setStation} placeholder="e.g. Rubis Mamboleo" />
      <Field label="Receipt no." value={receiptNo} onChangeText={setReceiptNo} />
      <View style={[s.row, { justifyContent: 'space-between', marginBottom: 14 }]}>
        <Text style={{ color: C.ink, fontSize: 15 }}>{t('full_tank')}</Text>
        <Switch value={full} onValueChange={setFull} trackColor={{ true: C.brand }} />
      </View>
      <Text style={s.label}>{t('receipt')}</Text>
      <Pressable onPress={async () => setReceipt(await takePhoto())} style={{ height: 140, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: '#AAB5B0', alignItems: 'center', justifyContent: 'center', marginBottom: 16, overflow: 'hidden' }}>
        {receipt ? <Image source={{ uri: receipt }} style={{ width: '100%', height: '100%' }} /> : <Text style={{ color: C.brand, fontWeight: '600' }}>{t('take_photo')}</Text>}
      </Pressable>
      <Button title={t('submit')} loading={busy} disabled={!(Number(litres) > 0)} onPress={() => void submit()} style={{ marginBottom: 30 }} />
    </ScrollView>
  );
}
