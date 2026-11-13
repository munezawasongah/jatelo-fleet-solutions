import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, router, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from '@/components/ui';
import { flushOutbox } from '@/lib/api';
import { listenForTaps, registerPush } from '@/lib/push';
import { SessionProvider, useSession } from '@/lib/session';
import '@/lib/tracking'; // registers the background location task at startup

void SplashScreen.preventAutoHideAsync();
const qc = new QueryClient({ defaultOptions: { queries: { retry: 2, staleTime: 15_000, refetchOnWindowFocus: true } } });

function Gate(): ReactNode {
  const { ready, signedIn } = useSession();
  const seg = useSegments();
  useEffect(() => {
    if (!ready) return;
    void SplashScreen.hideAsync();
    const inLogin = seg[0] === 'login';
    if (!signedIn && !inLogin) router.replace('/login');
    if (signedIn && inLogin) router.replace('/(tabs)');
    if (signedIn) {
      void registerPush();
      void flushOutbox();
    }
  }, [ready, signedIn, seg]);
  useEffect(() => listenForTaps(), []);
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: C.brandDark }, headerTintColor: C.white, headerTitleStyle: { fontWeight: '600' }, contentStyle: { backgroundColor: C.bg } }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="job/[id]" options={{ title: 'Job' }} />
      <Stack.Screen name="inspection" options={{ title: 'Inspection' }} />
      <Stack.Screen name="fuel" options={{ title: 'Fuel' }} />
      <Stack.Screen name="defect" options={{ title: 'Report a problem' }} />
    </Stack>
  );
}

export default function Root(): ReactNode {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <StatusBar style="light" />
          <Gate />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
