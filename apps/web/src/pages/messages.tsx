import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Paperclip, Send } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MultiRefSelect } from '../components/forms';
import { Badge, Button, Empty, Field, Modal, Spinner, Textarea, cx, errorText, useToast } from '../components/ui';
import { api, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtAgo, fmtDateTime, fmtTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useRealtime } from '../lib/realtime';

export default function MessagesPage(): ReactNode {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [active, setActive] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [broadcast, setBroadcast] = useState(false);
  const threads = useQuery({ queryKey: ['threads', q], queryFn: () => api.get<{ data: Row[]; unread_total: number }>('/messages/threads', { q: q || undefined }) });
  const drivers = useQuery({ queryKey: ['options', '/drivers'], queryFn: () => api.get<{ data: Row[] }>('/drivers', { page_size: 200, status: 'active' }) });
  useRealtime<Row>('message', (m) => {
    void qc.invalidateQueries({ queryKey: ['threads'] });
    if (m.driver_id === active) void qc.invalidateQueries({ queryKey: ['thread', active] });
  });
  const list = threads.data?.data ?? [];
  const known = new Set(list.map((x) => String(x.driver_id)));
  const others = (drivers.data?.data ?? []).filter((d) => !known.has(String(d.id)) && (!q || String(d.full_name).toLowerCase().includes(q.toLowerCase())));
  const activeName = list.find((x) => x.driver_id === active)?.driver_name ?? (drivers.data?.data ?? []).find((d) => d.id === active)?.full_name;
  return (
    <div className="flex h-full">
      <aside className={cx('w-full shrink-0 flex-col border-r border-black/[0.06] bg-white md:flex md:w-80', active ? 'hidden' : 'flex')}>
        <div className="flex items-center gap-2 border-b border-black/[0.06] p-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-9 flex-1 rounded-lg bg-black/[0.04] px-3 text-sm outline-none focus:ring-2 focus:ring-brand-500" />
          {can('messages:write') && <Button size="sm" variant="secondary" icon={<Megaphone className="size-4" />} aria-label="Broadcast" onClick={() => setBroadcast(true)} />}
        </div>
        <ul className="flex-1 overflow-y-auto scroll-thin">
          {list.map((th) => (
            <li key={String(th.driver_id)}>
              <button type="button" onClick={() => setActive(String(th.driver_id))} className={cx('flex w-full gap-3 border-b border-black/[0.04] px-3 py-3 text-left hover:bg-black/[0.02]', active === th.driver_id && 'bg-brand-50')}>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">{String(th.driver_name).split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{String(th.driver_name)}</span><span className="shrink-0 text-[11px] text-ink/45">{fmtAgo(th.last_at, lang)}</span></span>
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-xs text-ink/55">{th.last_sender === 'driver' ? '' : 'You: '}{String(th.last_body ?? (th.last_has_attachment ? '📎 Attachment' : ''))}</span>{Number(th.unread) > 0 && <Badge tone="green">{String(th.unread)}</Badge>}</span>
                </span>
              </button>
            </li>
          ))}
          {others.length > 0 && <li className="bg-black/[0.02] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink/45">Start a conversation</li>}
          {others.map((d) => (
            <li key={String(d.id)}><button type="button" onClick={() => setActive(String(d.id))} className="w-full border-b border-black/[0.04] px-3 py-2.5 text-left text-sm hover:bg-black/[0.02]">{String(d.full_name)}</button></li>
          ))}
        </ul>
      </aside>
      <section className={cx('min-w-0 flex-1 flex-col', active ? 'flex' : 'hidden md:flex')}>
        {active ? <Conversation driverId={active} name={String(activeName ?? '')} onBack={() => setActive(null)} /> : <div className="m-auto"><Empty title={t('messages')}>Choose a driver to start chatting. Messages reach the Jatelo Fleet Driver app instantly with a push notification.</Empty></div>}
      </section>
      <Modal open={broadcast} onClose={() => setBroadcast(false)} title="Broadcast to drivers">{broadcast && <Broadcast onDone={() => setBroadcast(false)} />}</Modal>
    </div>
  );
}

function Conversation({ driverId, name, onBack }: { driverId: string; name: string; onBack: () => void }): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['thread', driverId], queryFn: () => api.get<{ data: Row[] }>(`/messages/threads/${driverId}`, { limit: 100 }) });
  const msgs = [...(q.data?.data ?? [])].reverse();
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
    if (msgs.some((m) => m.sender_type === 'driver' && !m.read_at)) void api.post(`/messages/threads/${driverId}/read`).then(() => qc.invalidateQueries({ queryKey: ['threads'] }));
  }, [msgs.length, driverId]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (attachment?: File): Promise<void> => {
    if (!text.trim() && !attachment) return;
    setBusy(true);
    try {
      const fileId = attachment ? await api.upload(attachment, attachment.type.startsWith('image/') ? 'proof_of_delivery' : 'other') : undefined;
      await api.post(`/messages/threads/${driverId}`, { body: text.trim() || undefined, attachment_file_id: fileId, client_msg_id: crypto.randomUUID() });
      setText('');
      await q.refetch();
      void qc.invalidateQueries({ queryKey: ['threads'] });
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <header className="flex items-center gap-3 border-b border-black/[0.06] bg-white px-4 py-3">
        <button type="button" onClick={onBack} className="text-sm text-brand-700 md:hidden">← {t('back')}</button>
        <p className="font-semibold">{name}</p>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto bg-surface p-4 scroll-thin">
        {q.isPending && <div className="flex justify-center"><Spinner /></div>}
        {msgs.map((m) => {
          const mine = m.sender_type !== 'driver';
          return (
            <div key={String(m.id)} className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className={cx('max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm', mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-white ring-1 ring-black/[0.06]')}>
                {mine && Boolean(m.sender_name) && <p className="mb-0.5 text-[11px] opacity-70">{String(m.sender_name)}</p>}
                {Boolean(m.body) && <p className="whitespace-pre-wrap break-words">{String(m.body)}</p>}
                {Boolean(m.attachment_file_id) && <AttachmentLink id={String(m.attachment_file_id)} name={String(m.attachment_name ?? 'Attachment')} />}
                {Boolean(m.job_reference) && <p className="mt-1 text-[11px] opacity-75">Job {String(m.job_reference)}</p>}
                <p className={cx('mt-0.5 text-right text-[10px]', mine ? 'text-white/70' : 'text-ink/40')} title={fmtDateTime(m.sent_at)}>
                  {fmtTime(m.sent_at)}{mine ? (m.read_at ? ' · read' : m.delivered_at ? ' · delivered' : ' · sent') : ''}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {can('messages:write') && (
        <form className="flex items-end gap-2 border-t border-black/[0.06] bg-white p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <input ref={file} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f); e.target.value = ''; }} />
          <Button variant="ghost" icon={<Paperclip className="size-4" />} aria-label="Attach" onClick={() => file.current?.click()} />
          <Textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('type_message')} className="max-h-32 min-h-9 resize-none" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <Button type="submit" loading={busy} icon={<Send className="size-4" />} aria-label={t('send')} />
        </form>
      )}
    </>
  );
}

function AttachmentLink({ id, name }: { id: string; name: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs underline" disabled={busy} onClick={async () => {
      setBusy(true);
      try { const f = await api.get<{ download_url: string }>(`/files/${id}`); window.open(f.download_url, '_blank', 'noopener'); } finally { setBusy(false); }
    }}>📎 {name}</button>
  );
}

function Broadcast({ onDone }: { onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { toast } = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const [body, setBody] = useState('');
  return (
    <div className="space-y-4">
      <Field label={t('drivers')}><MultiRefSelect path="/drivers" label={(d) => String(d.full_name)} value={ids} onChange={setIds} /></Field>
      <Field label="Message"><Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>{t('cancel')}</Button>
        <Button disabled={!ids.length || !body.trim()} onClick={async () => {
          try { const r = await api.post<{ sent: number }>('/messages/broadcast', { driver_ids: ids, body }); toast(`Sent to ${r.sent} drivers`); onDone(); } catch (e) { toast(errorText(e), 'error'); }
        }}>{t('send')}</Button>
      </div>
    </div>
  );
}
