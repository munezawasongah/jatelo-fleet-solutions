import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Smartphone } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Pager, Table, usePaged } from '../components/table';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Spinner, Stat, StatusBadge, cx, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function BillingPage(): ReactNode {
  const { t } = useI18n();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const o = useQuery({ queryKey: ['billing'], queryFn: () => api.get<Row & { subscription: Row | null; usage: Row; next_invoice_estimate: Row | null; payment_methods: Row }>('/billing/overview') });
  const plans = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => api.get<{ data: Row[] }>('/billing/plans') });
  const invoices = usePaged('/billing/invoices', {});
  const payments = usePaged('/billing/payments', {}, { pageSize: 10 });
  const [pay, setPay] = useState<Row | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  if (!o.data) return <div className="flex justify-center py-24"><Spinner /></div>;
  const s = o.data.subscription;
  const cur = String(s?.currency ?? me?.tenant?.currency ?? 'KES');
  const manage = can('billing:manage');
  const refreshAll = (): void => { void qc.invalidateQueries({ queryKey: ['billing'] }); void qc.invalidateQueries({ queryKey: ['/billing/invoices'] }); void qc.invalidateQueries({ queryKey: ['/billing/payments'] }); void qc.invalidateQueries({ queryKey: ['me'] }); };
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader title={t('billing')} subtitle="Simple per-vehicle pricing. Pay with M-Pesa straight from here." />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label={t('current_plan')} value={String(s?.plan_name ?? '—')} sub={s ? `${fmtMoney(s.price_per_vehicle, cur)} ${t('per_vehicle_month')}` : undefined} />
        <Stat label={t('vehicles_billed')} value={`${fmtNum((o.data.usage as Row).vehicles)} / ${fmtNum(s?.vehicle_quota)}`} sub={o.data.over_quota ? 'Over your plan quota' : 'Active vehicles / quota'} tone={o.data.over_quota ? 'bad' : 'flat'} />
        <Stat label={t('balance_due')} value={fmtMoney(o.data.balance, cur)} sub={Number(o.data.overdue_invoices) ? `${String(o.data.overdue_invoices)} ${t('overdue').toLowerCase()}` : undefined} tone={Number(o.data.overdue_invoices) ? 'bad' : 'flat'} />
        <Stat label={t('next_invoice')} value={o.data.next_invoice_estimate ? fmtMoney((o.data.next_invoice_estimate as Row).total, cur) : '—'} sub={o.data.next_invoice_estimate ? `${fmtDate((o.data.next_invoice_estimate as Row).date)} · incl. VAT ${String((o.data.next_invoice_estimate as Row).tax_rate)}%` : undefined} />
      </div>
      {s && (
        <Card title={t('current_plan')} actions={manage && <Button size="sm" variant="secondary" onClick={() => setPlanOpen(true)}>{t('change_plan')}</Button>}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge value={s.status} />
            <span>Period {fmtDate(s.current_period_start)} – {fmtDate(s.current_period_end)}</span>
            {Boolean(s.trial_ends_at) && s.status === 'trialing' && <Badge tone="blue">Trial ends {fmtDate(s.trial_ends_at)}</Badge>}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">{((s.features as string[]) ?? []).map((f) => <Badge key={f}>{f.replace(/_/g, ' ')}</Badge>)}</div>
        </Card>
      )}
      <Card title={t('invoices')} pad={false}>
        <Table rows={invoices.rows} loading={invoices.isPending} columns={[
          { key: 'number', render: (r) => <span className="font-mono text-xs">{String(r.number)}</span> },
          { key: 'period', label: t('period'), render: (r) => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}` },
          { key: 'vehicle_count', label: t('vehicles'), type: 'number' },
          { key: 'total', label: 'Total', render: (r) => fmtMoney(r.total, String(r.currency)), align: 'right' },
          { key: 'balance', label: t('balance_due'), render: (r) => fmtMoney(r.balance, String(r.currency)), align: 'right' },
          { key: 'due_date', type: 'date' },
          { key: 'status', type: 'status' },
        ]} rowActions={(r) => (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon={<Download className="size-4" />} aria-label="PDF" onClick={() => void api.download(`/billing/invoices/${String(r.id)}/pdf`, undefined, `${String(r.number)}.pdf`).catch((e: unknown) => toast(errorText(e), 'error'))} />
            {manage && ['open', 'overdue'].includes(String(r.status)) && Boolean(o.data.payment_methods && (o.data.payment_methods as Row).mpesa) && r.currency === 'KES' && (
              <Button size="sm" icon={<Smartphone className="size-4" />} onClick={() => setPay(r)}>{t('pay_with_mpesa')}</Button>
            )}
          </div>
        )} />
        <Pager page={invoices.page} pageSize={invoices.pageSize} total={invoices.total} onPage={invoices.setPage} />
      </Card>
      <Card title={t('payments')} pad={false}>
        <Table rows={payments.rows} loading={payments.isPending} columns={[
          { key: 'created_at', type: 'datetime' }, { key: 'invoice_number', label: 'Invoice' }, { key: 'method', render: (r) => String(r.method).replace('_', ' ').toUpperCase() },
          { key: 'amount', render: (r) => fmtMoney(r.amount, String(r.currency)), align: 'right' }, { key: 'provider_reference', label: 'Reference', render: (r) => <span className="font-mono text-xs">{String(r.provider_reference ?? '—')}</span> },
          { key: 'status', type: 'status' },
        ]} />
        <Pager page={payments.page} pageSize={payments.pageSize} total={payments.total} onPage={payments.setPage} />
      </Card>
      <p className="text-xs text-ink/50">Prefer Paybill? Use the invoice number as the account number. For bank transfer or other mobile money, email billing@jatelo-techs.com.</p>
      <Modal open={Boolean(pay)} onClose={() => setPay(null)} title={`${t('pay_with_mpesa')} · ${String(pay?.number ?? '')}`} size="sm">
        {pay && <MpesaPay invoice={pay} simulated={Boolean((o.data.payment_methods as Row).mpesa_simulated)} onDone={() => { setPay(null); refreshAll(); }} />}
      </Modal>
      <Modal open={planOpen} onClose={() => setPlanOpen(false)} title={t('change_plan')} size="lg">
        <div className="grid gap-3 md:grid-cols-3">
          {(plans.data?.data ?? []).map((p) => (
            <div key={String(p.code)} className={cx('flex flex-col rounded-xl p-4 ring-1', p.code === s?.plan_code ? 'bg-brand-50 ring-brand-500' : 'ring-black/10')}>
              <p className="font-semibold">{String(p.name)}</p>
              <p className="mt-1 text-2xl font-semibold tabular">{fmtMoney(p.price_per_vehicle, String(p.currency))}</p>
              <p className="text-xs text-ink/55">{t('per_vehicle_month')}{Number(p.min_vehicles) > 1 ? ` · min ${String(p.min_vehicles)}` : ''}</p>
              <p className="mt-2 flex-1 text-sm text-ink/70">{String(p.description ?? '')}</p>
              <Button className="mt-3" size="sm" variant={p.code === s?.plan_code ? 'secondary' : 'primary'} disabled={p.code === s?.plan_code}
                onClick={() => void api.post('/billing/change-plan', { plan_code: p.code }).then(() => { toast('Plan changed - the new price applies from your next invoice'); setPlanOpen(false); refreshAll(); }, (e: unknown) => toast(errorText(e), 'error'))}>
                {p.code === s?.plan_code ? t('current_plan') : `Switch to ${String(p.name)}`}
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function MpesaPay({ invoice, simulated, onDone }: { invoice: Row; simulated: boolean; onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { me } = useAuth();
  const [phone, setPhone] = useState(String(me?.user.phone ?? ''));
  const [payment, setPayment] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useQuery({ queryKey: ['payment', payment], queryFn: () => api.get<Row>(`/billing/payments/${payment}`), enabled: Boolean(payment), refetchInterval: (q) => (q.state.data?.status === 'pending' ? 3000 : false) });
  const st = String(status.data?.status ?? (payment ? 'pending' : ''));
  useEffect(() => {
    if (st === 'succeeded') setTimeout(onDone, 2500);
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ payment_id: string }>(`/billing/invoices/${String(invoice.id)}/mpesa`, { phone });
      setPayment(r.payment_id);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm">Amount: <b className="tabular">{fmtMoney(invoice.balance, String(invoice.currency))}</b></p>
      {!payment ? (
        <>
          <Field label={t('mpesa_phone')} hint="Safaricom number, e.g. 0712 345 678"><Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus /></Field>
          {simulated && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Demo mode: M-Pesa credentials are not configured, so this payment is simulated.</p>}
          {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
          <Button className="w-full" loading={busy} disabled={phone.replace(/\D/g, '').length < 9} onClick={() => void start()}>{t('pay_with_mpesa')}</Button>
        </>
      ) : st === 'pending' ? (
        <div className="space-y-3 py-4 text-center"><Spinner className="mx-auto size-8 text-brand-600" /><p className="text-sm font-medium">{t('check_phone')}</p><p className="text-xs text-ink/50">Waiting for confirmation from M-Pesa…</p></div>
      ) : st === 'succeeded' ? (
        <div className="space-y-2 py-4 text-center"><p className="text-3xl">✅</p><p className="font-medium">{t('payment_received')}</p><p className="font-mono text-xs text-ink/55">{String(status.data?.provider_reference ?? '')} · {fmtDateTime(status.data?.paid_at)}</p></div>
      ) : (
        <div className="space-y-3 text-center"><p className="text-sm text-red-700">{String(status.data?.failure_reason ?? 'The payment did not go through.')}</p><Button variant="secondary" onClick={() => setPayment(null)}>Try again</Button></div>
      )}
    </div>
  );
}
