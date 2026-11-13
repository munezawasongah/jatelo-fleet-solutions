import { useQuery } from '@tanstack/react-query';
import { Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CrudPage, Table } from '../components/table';
import { Badge, Button, Field, Modal, Select, Input, StatusBadge, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function DevicesPage(): ReactNode {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [online, setOnline] = useState('');
  const [cmd, setCmd] = useState<Row | null>(null);
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <CrudPage
        path="/devices"
        title={t('devices')}
        subtitle="GPS trackers are supplied and provisioned by Jatelo. Assign them to vehicles from the vehicle page."
        write="devices:assign"
        canCreate={false}
        canDelete={false}
        params={{ online: online || undefined }}
        filters={
          <Select value={online} onChange={(e) => setOnline(e.target.value)} className="w-36" aria-label={t('status')}>
            <option value="">{t('all')}</option>
            <option value="true">Online</option>
            <option value="false">{t('offline')}</option>
          </Select>
        }
        formOpts={{ hide: ['io_mapping', 'capabilities'] }}
        extraActions={can('devices:assign') ? (r) => <Button size="sm" variant="ghost" icon={<Terminal className="size-4" />} aria-label={t('send_command')} onClick={() => setCmd(r)} /> : undefined}
        columns={[
          { key: 'identifier', label: 'IMEI', render: (r) => <span className="font-mono text-xs">{String(r.identifier)}</span> },
          { key: 'model', render: (r) => `${String(r.model ?? '—')} · ${String(r.protocol)}` },
          { key: 'vehicle', label: t('vehicle'), render: (r) => String((r.vehicle as Row | null)?.plate_number ?? '—') },
          { key: 'sim', label: 'SIM', render: (r) => String((r.sim as Row | null)?.msisdn ?? '—') },
          { key: 'health', label: t('last_seen'), render: (r) => { const h = r.health as Row; return <span className="inline-flex items-center gap-2">{h.online ? <Badge tone="green">Online</Badge> : <Badge tone="red">{t('offline')}</Badge>}<span className="text-xs text-ink/55">{fmtAgo(h.last_seen_at, lang)}</span></span>; } },
          { key: 'power', label: 'Power', render: (r) => { const h = r.health as Row; return h.ext_voltage_mv ? `${(Number(h.ext_voltage_mv) / 1000).toFixed(1)} V` : '—'; } },
          { key: 'status', type: 'status' },
        ]}
      />
      <Modal open={Boolean(cmd)} onClose={() => setCmd(null)} title={`${t('send_command')} · ${String(cmd?.identifier ?? '')}`} size="lg">
        {cmd && <Commands device={cmd} />}
      </Modal>
    </div>
  );
}

function Commands({ device }: { device: Row }): ReactNode {
  const { t } = useI18n();
  const { me } = useAuth();
  const { toast, confirm } = useToast();
  const [type, setType] = useState('get_info');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const hist = useQuery({ queryKey: ['commands', device.id], queryFn: () => api.get<{ data: Row[] }>(`/devices/${String(device.id)}/commands`), refetchInterval: 5000 });
  const send = async (): Promise<void> => {
    if (type === 'immobilize' && !(await confirm('Cut the engine? Only do this for a stolen vehicle or with the driver informed.', { danger: true, label: t('immobilize') }))) return;
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>(`/devices/${String(device.id)}/commands`, { command_type: type, payload: type === 'custom' ? payload : undefined, confirm: true });
      toast(r.message);
      void hist.refetch();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Command">
          <Select value={type} onChange={(e) => setType(e.target.value)} className="w-56">
            <option value="get_info">Get device info</option>
            <option value="reboot">Reboot tracker</option>
            <option value="immobilize">{t('immobilize')}</option>
            <option value="restore">{t('restore_engine')}</option>
            {me?.user.role === 'company_admin' && <option value="custom">Raw command</option>}
          </Select>
        </Field>
        {type === 'custom' && <Field label="Text"><Input value={payload} onChange={(e) => setPayload(e.target.value)} className="w-72 font-mono" /></Field>}
        <Button loading={busy} variant={type === 'immobilize' ? 'danger' : 'primary'} onClick={() => void send()}>{t('send')}</Button>
      </div>
      <Table rows={hist.data?.data ?? []} loading={hist.isPending} columns={[
        { key: 'created_at', type: 'datetime' }, { key: 'command_type', render: (r) => t(String(r.command_type)) }, { key: 'status', render: (r) => <StatusBadge value={r.status} /> },
        { key: 'requested_by_name', label: 'By' }, { key: 'response', render: (r) => <span className="font-mono text-xs">{String(r.response ?? '—')}</span> },
        { key: 'responded_at', render: (r) => fmtDateTime(r.responded_at) },
      ]} />
    </div>
  );
}
