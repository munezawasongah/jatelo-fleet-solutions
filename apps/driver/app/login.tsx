import { useState, type ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, C, Field, Muted } from '@/components/ui';
import { setLang, useLang } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function Login(): ReactNode {
  const { t, lang } = useLang();
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try { await signIn(email, password); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.brandDark }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <View style={{ alignItems: 'center', marginBottom: 28 }}>
          <Image source={require('../assets/icon.png')} style={{ width: 72, height: 72, borderRadius: 16 }} />
          <Text style={{ color: C.white, fontSize: 22, fontWeight: '700', marginTop: 14 }}>Jatelo Fleet Driver</Text>
          <Text style={{ color: '#ffffffaa', marginTop: 4 }}>{lang === 'sw' ? 'Kazi, safari na ujumbe wako mahali pamoja' : 'Your jobs, trips and messages in one place'}</Text>
        </View>
        <View style={{ backgroundColor: C.white, borderRadius: 16, padding: 18 }}>
          <Field label={t('email')} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <Field label={t('password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={() => void submit()} />
          {err && <Text style={{ color: C.red, marginBottom: 10 }}>{err}</Text>}
          <Button title={t('sign_in')} onPress={() => void submit()} loading={busy} disabled={!email || !password} />
          <Muted style={{ marginTop: 12, textAlign: 'center' }}>{lang === 'sw' ? 'Akaunti yako huundwa na msimamizi wa magari.' : 'Your login is created by your fleet manager.'}</Muted>
        </View>
        <Pressable onPress={() => setLang(lang === 'en' ? 'sw' : 'en')} style={{ alignSelf: 'center', marginTop: 18, padding: 8 }}>
          <Text style={{ color: C.white, fontWeight: '600' }}>{lang === 'en' ? 'Kiswahili' : 'English'}</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
