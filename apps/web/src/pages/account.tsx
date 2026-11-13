import { useMutation, useQuery } from '@tanstack/react-query';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Table } from '../components/table';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { MfaSetup } from './auth';

export default function AccountPage(): ReactNode {
  const { t, lang, setLang } = useI18n();
  const { me, reload, logout } = useAuth();
  const { toast, confirm } = useToast();
  const nav = useNavigate();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [setup, setSetup] = useState(false);
  const [disable, setDisable] = useState(false);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ sessions: Row[] }>('/auth/sessions') });
  const change = useMutation({
    mutationFn: () => api.post('/auth/password/change', { current_password: cur, new_password: pw }),
    onSuccess: () => { toast('Password changed. Other devices were signed out.'); setCur(''); setPw(''); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (!me) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <PageHeader title={`${t('profile')} & ${t('security')}`} subtitle={`${me.user.full_name} · ${me.user.email} · ${t(me.user.role)}`} />
      <Card title={t('language')}>
        <Select value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'sw')} className="w-48"><option value="en">English</option><option value="sw">Kiswahili</option></Select>
      </Card>
      <Card title="Two-step verification">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">{me.user.mfa_enabled ? <Badge tone="green"><ShieldCheck className="size-3.5" /> On</Badge> : <Badge tone="amber">Off</Badge>} <span className="ml-2 text-ink/60">Codes from Google Authenticator or Microsoft Authenticator.</span></p>
          {me.user.mfa_enabled ? <Button variant="secondary" onClick={() => setDisable(true)}>Turn off</Button> : <Button onClick={() => setSetup(true)}>Turn on</Button>}
        </div>
      </Card>
      <Card title="Change password">
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <Field label="Current password"><Input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label={t('new_password')}><Input type="password" autoComplete="new-password" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Button type="submit" loading={change.isPending}>{t('save')}</Button>
        </form>
      </Card>
      <Card title="Signed-in devices" pad={false} actions={<Button size="sm" variant="secondary" icon={<LogOut className="size-4" />} onClick={async () => { if (await confirm('Sign out of every device, including this one?')) { await api.post('/auth/logout-all'); await logout(); nav('/login'); } }}>Sign out everywhere</Button>}>
        <Table rows={sessions.data?.sessions ?? []} loading={sessions.isPending} columns={[
          { key: 'user_agent', label: 'Device', render: (r) => <span className="line-clamp-1 max-w-xs text-xs">{String(r.user_agent ?? 'Unknown')}{r.current ? ' (this device)' : ''}</span> },
          { key: 'ip', label: 'IP', render: (r) => <span className="font-mono text-xs">{String(r.ip ?? '')}</span> },
          { key: 'last_used_at', label: 'Last active', render: (r) => fmtAgo(r.last_used_at ?? r.started_at, lang) },
        ]} rowActions={(r) => (r.current ? null : <Button size="sm" variant="ghost" onClick={() => void api.del(`/auth/sessions/${String(r.id)}`).then(() => sessions.refetch())}>Sign out</Button>)} />
      </Card>
      <Modal open={setup} onClose={() => setSetup(false)} title={t('setup_2fa')} size="sm">{setup && <MfaSetup onDone={() => { setSetup(false); void reload(); }} />}</Modal>
      <Modal open={disable} onClose={() => setDisable(false)} title="Turn off 2FA" size="sm">{disable && <DisableMfa onDone={() => { setDisable(false); void reload(); }} />}</Modal>
    </div>
  );
}

function DisableMfa({ onDone }: { onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); try { await api.post('/auth/mfa/disable', { password, code }); onDone(); } catch (x) { toast(errorText(x), 'error'); } }}>
      <p className="text-sm text-ink/60">Administrator accounts must keep 2FA on.</p>
      <Field label={t('password')}><Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label={t('verification_code')}><Input inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      <div className="flex justify-end"><Button type="submit" variant="danger">Turn off</Button></div>
    </form>
  );
}
