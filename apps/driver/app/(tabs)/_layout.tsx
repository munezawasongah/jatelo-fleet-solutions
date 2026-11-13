import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ReactNode } from 'react';
import { C } from '@/components/ui';
import { useLang } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function TabsLayout(): ReactNode {
  const { t } = useLang();
  const { home } = useSession();
  return (
    <Tabs screenOptions={{ headerStyle: { backgroundColor: C.brandDark }, headerTintColor: C.white, tabBarActiveTintColor: C.brand, tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 } }}>
      <Tabs.Screen name="index" options={{ title: t('home'), headerTitle: home?.company.name ?? 'Jatelo Fleet', tabBarIcon: ({ color, size }) => <Ionicons name="home" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="jobs" options={{ title: t('jobs'), tabBarBadge: home?.counts.jobs || undefined, tabBarIcon: ({ color, size }) => <Ionicons name="navigate" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="messages" options={{ title: t('messages'), tabBarBadge: home?.counts.unread || undefined, tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="more" options={{ title: t('more'), tabBarIcon: ({ color, size }) => <Ionicons name="menu" color={String(color)} size={size} /> }} />
    </Tabs>
  );
}
