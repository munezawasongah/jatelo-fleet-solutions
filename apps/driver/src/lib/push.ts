import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

/** Registers the FCM device token with the API (the worker sends pushes through FCM HTTP v1). */
export async function registerPush(): Promise<void> {
  if (!Device.isDevice) return;
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', { name: 'Jobs & messages', importance: Notifications.AndroidImportance.HIGH, lightColor: '#0F6B4F' });
  const perm = await Notifications.getPermissionsAsync();
  const status = perm.granted ? 'granted' : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;
  try {
    const tok = await Notifications.getDevicePushTokenAsync();
    await api.post('/push-tokens', { token: String(tok.data), platform: Platform.OS === 'ios' ? 'ios' : 'android', device_name: Device.modelName ?? undefined, app_version: Application.nativeApplicationVersion ?? undefined });
  } catch (e) {
    console.warn('push registration failed', e);
  }
}

/** Opens the right screen when a notification is tapped. */
export function listenForTaps(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const d = r.notification.request.content.data as { type?: string; job_id?: string };
    if (d.type === 'job' && d.job_id) router.push(`/job/${d.job_id}`);
    else if (d.type === 'message') router.push('/(tabs)/messages');
  });
  return () => sub.remove();
}
