import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useEffect, useState, type ReactNode } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { C, Muted, s } from '@/components/ui';
import { api, sendOrQueue } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { takePhoto } from '@/lib/photo';

type Msg = { id: string; body: string | null; sender_type: string; sender_name: string | null; sent_at: string; read_at: string | null; attachment_file_id: string | null; local?: boolean };

export default function MessagesTab(): ReactNode {
  const { t } = useLang();
  const { refreshHome } = useSession();
  const [text, setText] = useState('');
  const [local, setLocal] = useState<Msg[]>([]);
  const q = useQuery({ queryKey: ['messages'], queryFn: () => api.get<{ data: Msg[]; unread: number }>('/messages/my?limit=100'), refetchInterval: 15_000 });
  const msgs = [...local.filter((l) => !(q.data?.data ?? []).some((m) => m.body === l.body && Math.abs(Date.parse(m.sent_at) - Date.parse(l.sent_at)) < 120_000)), ...(q.data?.data ?? [])];
  useEffect(() => {
    if ((q.data?.unread ?? 0) > 0) void api.post('/messages/my/read').then(refreshHome);
  }, [q.data?.unread]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (photo?: string): Promise<void> => {
    const body = text.trim();
    if (!body && !photo) return;
    const client_msg_id = Crypto.randomUUID();
    setLocal((l) => [{ id: client_msg_id, body: body || '📷', sender_type: 'driver', sender_name: null, sent_at: new Date().toISOString(), read_at: null, attachment_file_id: null, local: true }, ...l]);
    setText('');
    await sendOrQueue({ method: 'POST', path: '/messages/my', body: { body: body || undefined, client_msg_id }, files: photo ? [{ field: 'attachment_file_id', uris: [photo], purpose: 'proof_of_delivery', single: true }] : [], label: 'message' }).catch(() => undefined);
    void q.refetch();
  };
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FlatList
        inverted
        data={msgs}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12 }}
        ListEmptyComponent={<Muted style={{ textAlign: 'center', marginTop: 40 }}>{t('type_message')}</Muted>}
        renderItem={({ item: m }) => {
          const mine = m.sender_type === 'driver';
          return (
            <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginVertical: 3 }}>
              <View style={{ maxWidth: '80%', backgroundColor: mine ? C.brand : C.white, borderRadius: 16, borderBottomRightRadius: mine ? 4 : 16, borderBottomLeftRadius: mine ? 16 : 4, padding: 10, borderWidth: mine ? 0 : 1, borderColor: C.line }}>
                {!mine && Boolean(m.sender_name) && <Text style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>{m.sender_name}</Text>}
                <Text style={{ color: mine ? C.white : C.ink, fontSize: 15 }}>{m.body ?? (m.attachment_file_id ? '📎' : '')}</Text>
                <Text style={{ color: mine ? '#ffffffaa' : C.muted, fontSize: 10, textAlign: 'right', marginTop: 2 }}>
                  {new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{mine ? (m.local ? ' · …' : m.read_at ? ' · ✓✓' : ' · ✓') : ''}
                </Text>
              </View>
            </View>
          );
        }}
      />
      <View style={[s.row, { padding: 10, gap: 8, backgroundColor: C.white, borderTopWidth: 1, borderColor: C.line }]}>
        <Pressable onPress={async () => { const p = await takePhoto(); if (p) void send(p); }} style={{ padding: 8 }}><Ionicons name="camera" size={24} color={C.brand} /></Pressable>
        <TextInput value={text} onChangeText={setText} placeholder={t('type_message')} multiline style={[s.input, { flex: 1, maxHeight: 110, paddingVertical: 9 }]} />
        <Pressable onPress={() => void send()} disabled={!text.trim()} style={{ padding: 8, opacity: text.trim() ? 1 : 0.4 }}><Ionicons name="send" size={24} color={C.brand} /></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
