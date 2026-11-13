import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { Badge, C, Card, Muted, s } from '@/components/ui';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';

type Job = Record<string, unknown> & { stops: Record<string, unknown>[] };
const time = (v: unknown): string => (v ? new Date(String(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export default function JobsTab(): ReactNode {
  const { t } = useLang();
  const q = useQuery({ queryKey: ['jobs'], queryFn: () => api.get<{ data: Job[] }>('/jobs/my/current'), refetchInterval: 30_000 });
  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={{ padding: 16 }}
      data={q.data?.data ?? []}
      keyExtractor={(j) => String(j.id)}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
      ListEmptyComponent={<Muted style={{ textAlign: 'center', marginTop: 40 }}>{q.isPending ? '…' : t('no_jobs')}</Muted>}
      renderItem={({ item: j }) => {
        const next = j.stops.find((x) => ['pending', 'en_route', 'arrived'].includes(String(x.status)));
        return (
          <Pressable onPress={() => router.push(`/job/${String(j.id)}`)}>
            <Card>
              <View style={[s.row, { justifyContent: 'space-between', gap: 8 }]}>
                <Text style={{ fontSize: 16, fontWeight: '700', flex: 1, color: C.ink }}>{String(j.title)}</Text>
                <Badge status={String(j.status)} text={t(String(j.status))} />
              </View>
              <Muted>{String(j.reference)}{j.customer_name ? ` · ${String(j.customer_name)}` : ''}</Muted>
              {next && <Text style={{ marginTop: 8, color: C.ink }}>➜ {String(next.name)}{next.eta ? `  ·  ${t('eta')} ${time(next.eta)}` : ''}</Text>}
              <View style={{ height: 6, backgroundColor: '#EEF1F0', borderRadius: 3, marginTop: 10, overflow: 'hidden' }}>
                <View style={{ height: 6, width: `${Number(j.progress_pct ?? 0)}%`, backgroundColor: C.brand }} />
              </View>
            </Card>
          </Pressable>
        );
      }}
    />
  );
}
