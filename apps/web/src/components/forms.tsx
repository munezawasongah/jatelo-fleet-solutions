import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Page, type Row } from '../lib/api';
import { fromLocalInput, toLocalInput } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { bodySchema, unwrap, useOpenApi, type JsonSchema } from '../lib/schema';
import { Button, Checkbox, Field, Input, Select, Spinner, Textarea, cx, errorText, fieldErrors } from './ui';

/** Reference fields rendered as pickers. */
export const REFS: Record<string, { path: string; label: (r: Row) => string }> = {
  vehicle_id: { path: '/vehicles', label: (r) => [r.plate_number, r.label].filter(Boolean).join(' · ') },
  driver_id: { path: '/drivers', label: (r) => String(r.full_name) },
  group_id: { path: '/vehicle-groups', label: (r) => String(r.name) },
  parent_id: { path: '/vehicle-groups', label: (r) => String(r.name) },
  poi_id: { path: '/pois', label: (r) => String(r.name) },
  service_task_id: { path: '/service-tasks', label: (r) => String(r.name) },
  fuel_card_id: { path: '/fuel-cards', label: (r) => `${String(r.provider)} ••${String(r.card_last4)}${r.label ? ` · ${String(r.label)}` : ''}` },
  assigned_to: { path: '/users', label: (r) => String(r.full_name) },
  geofence_id: { path: '/geofences', label: (r) => String(r.name) },
  route_id: { path: '/routes', label: (r) => String(r.name) },
  template_id: { path: '/inspection-templates', label: (r) => String(r.name) },
};

export function useOptions(path: string, enabled = true): { options: Row[]; loading: boolean } {
  const q = useQuery({
    queryKey: ['options', path],
    queryFn: () => api.get<Page<Row>>(path, { page_size: 200 }),
    enabled,
    staleTime: 60_000,
  });
  return { options: q.data?.data ?? [], loading: q.isPending && enabled };
}

export function RefSelect({ field, value, onChange, required, id, allowEmpty = true, placeholder }: { field: string; value: unknown; onChange: (v: string | null) => void; required?: boolean; id?: string; allowEmpty?: boolean; placeholder?: string }): ReactNode {
  const ref = REFS[field]!;
  const { options, loading } = useOptions(ref.path);
  const { t } = useI18n();
  return (
    <Select id={id} value={value ? String(value) : ''} required={required} onChange={(e) => onChange(e.target.value || null)} disabled={loading}>
      {(allowEmpty || !value) && <option value="">{loading ? t('loading') : (placeholder ?? `— ${t('none')} —`)}</option>}
      {options.map((o) => (
        <option key={String(o.id)} value={String(o.id)}>
          {ref.label(o)}
        </option>
      ))}
    </Select>
  );
}

export function MultiRefSelect({ path, label, value, onChange }: { path: string; label: (r: Row) => string; value: string[]; onChange: (v: string[]) => void }): ReactNode {
  const { options } = useOptions(path);
  const [q, setQ] = useState('');
  const shown = options.filter((o) => !q || label(o).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="rounded-lg ring-1 ring-black/15">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="w-full border-b border-black/10 px-3 py-1.5 text-sm outline-none" />
      <div className="max-h-44 overflow-y-auto p-1 scroll-thin">
        {shown.map((o) => {
          const id = String(o.id);
          const on = value.includes(id);
          return (
            <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/[0.03]">
              <input type="checkbox" className="accent-brand-600" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== id) : [...value, id])} />
              {label(o)}
            </label>
          );
        })}
      </div>
    </div>
  );
}

type FieldOpts = {
  /** Fields not shown (and not sent). */
  hide?: string[];
  /** Fields shown first, in this order. */
  order?: string[];
  /** Custom renderers. */
  custom?: Record<string, (value: unknown, set: (v: unknown) => void) => ReactNode>;
  /** Full-width fields (textareas etc.). */
  wide?: string[];
};

function isDateTime(name: string, s: JsonSchema): boolean {
  return s.format === 'date-time' || /(_at|_from|_until)$/.test(name) || ['scheduled_for', 'starts_at', 'ends_at', 'filled_at'].includes(name);
}
function isDate(name: string, s: JsonSchema): boolean {
  return s.format === 'date' || /(_date|_on)$/.test(name) || name === 'date_of_birth';
}

/** Turns a DB row into initial form values for the given schema. */
function initialValues(schema: JsonSchema, row?: Row | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(schema.properties ?? {})) {
    let v = row?.[k];
    // nested shapes returned by list endpoints
    if (v === undefined && row && k.endsWith('_id')) {
      const obj = row[k.slice(0, -3)] as Row | undefined;
      if (obj && typeof obj === 'object' && 'id' in obj) v = obj.id;
    }
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Form generated from the API's own request schema (create: POST path, edit: PATCH path/{id}).
 * Only changed fields are sent on edit.
 */
export function EntityForm({ path, row, onSaved, onCancel, opts, extra, submitLabel, transform, schemaPath, submit: target }: {
  path: string;
  /** Singleton endpoints (e.g. PATCH /tenant): schema is read for this method at schemaPath ?? path and the form submits there. */
  submit?: { method: 'patch' | 'put' | 'post'; url: string };
  /** OpenAPI path template when `path` contains ids, e.g. /vehicles/{id}/documents */
  schemaPath?: string;
  row?: Row | null;
  onSaved: (r: Row) => void;
  onCancel?: () => void;
  opts?: FieldOpts;
  extra?: Record<string, unknown>;
  submitLabel?: string;
  transform?: (body: Record<string, unknown>) => Record<string, unknown>;
}): ReactNode {
  const doc = useOpenApi();
  const { t, f } = useI18n();
  const editing = Boolean(row?.id) || Boolean(target && row);
  const sp = schemaPath ?? path;
  const schema = target ? bodySchema(doc, target.method, sp) : bodySchema(doc, editing ? 'patch' : 'post', editing ? `${sp}/{id}` : sp);
  const createSchema = bodySchema(doc, 'post', sp);
  const required = new Set(createSchema?.required ?? []);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const init = useMemo(() => (schema ? initialValues(schema, row) : {}), [schema, row]);
  const v = values ?? init;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});

  if (!doc || !schema) return <div className="flex justify-center py-10"><Spinner /></div>;
  const hide = new Set(['custom_fields', ...(opts?.hide ?? [])]);
  const names = Object.keys(schema.properties ?? {}).filter((k) => !hide.has(k));
  const ordered = [...(opts?.order ?? []).filter((k) => names.includes(k)), ...names.filter((k) => !(opts?.order ?? []).includes(k))];
  const set = (k: string, x: unknown): void => setValues({ ...v, [k]: x });

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setErrs({});
    try {
      let body: Record<string, unknown> = {};
      for (const k of ordered) {
        const val = v[k];
        if (editing ? JSON.stringify(val) === JSON.stringify(init[k]) : val === undefined || val === '') continue;
        body[k] = val === '' ? null : val;
      }
      body = { ...body, ...(extra ?? {}) };
      if (transform) body = transform(body);
      const saved = target
        ? await (target.method === 'patch' ? api.patch<Row>(target.url, body) : target.method === 'put' ? api.put<Row>(target.url, body) : api.post<Row>(target.url, body))
        : editing ? await api.patch<Row>(`${path}/${String(row!.id)}`, body) : await api.post<Row>(path, body);
      onSaved(saved);
    } catch (ex) {
      setErr(errorText(ex));
      setErrs(fieldErrors(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {ordered.map((name) => {
          const { schema: s, nullable } = unwrap(doc, schema.properties![name]!);
          const val = v[name];
          const id = `f-${name}`;
          const label = f(name);
          const req = required.has(name) && !editing;
          const custom = opts?.custom?.[name];
          const wide = opts?.wide?.includes(name) || name === 'notes' || name === 'description' || s.type === 'array' || s.type === 'object' || (s.maxLength ?? 0) > 300;
          let control: ReactNode;
          if (custom) control = custom(val, (x) => set(name, x));
          else if (REFS[name]) control = <RefSelect id={id} field={name} value={val} onChange={(x) => set(name, x)} required={req} allowEmpty={nullable || !req} />;
          else if (s.enum) {
            control = (
              <Select id={id} value={val === undefined || val === null ? '' : String(val)} required={req} onChange={(e) => set(name, e.target.value === '' ? (nullable ? null : undefined) : typeof s.enum![0] === 'number' ? Number(e.target.value) : e.target.value)}>
                {(!req || val === undefined) && <option value="">—</option>}
                {s.enum.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {t(String(o))}
                  </option>
                ))}
              </Select>
            );
          } else if (s.type === 'boolean') control = <div className="pt-1.5"><Checkbox label={label} checked={Boolean(val ?? s.default)} onChange={(e) => set(name, e.target.checked)} /></div>;
          else if (s.type === 'integer' || s.type === 'number')
            control = <Input id={id} type="number" required={req} step={s.type === 'integer' ? 1 : 'any'} min={s.minimum ?? s.exclusiveMinimum} max={s.maximum} value={val === undefined || val === null ? '' : String(val)} onChange={(e) => set(name, e.target.value === '' ? null : Number(e.target.value))} />;
          else if (s.type === 'array' && unwrap(doc, s.items ?? {}).schema.enum) {
            const items = unwrap(doc, s.items ?? {}).schema.enum!;
            const arr = (val as string[] | undefined) ?? [];
            control = (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg p-2 ring-1 ring-black/10">
                {items.map((o) => (
                  <Checkbox key={String(o)} label={t(String(o))} checked={arr.includes(String(o))} onChange={(e) => set(name, e.target.checked ? [...arr, String(o)] : arr.filter((x) => x !== String(o)))} />
                ))}
              </div>
            );
          } else if (s.type === 'array' && unwrap(doc, s.items ?? {}).schema.type === 'string' && !/_ids$/.test(name))
            control = <Input id={id} value={((val as string[] | undefined) ?? []).join(', ')} placeholder="comma, separated" onChange={(e) => set(name, e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
          else if (s.type === 'array' || s.type === 'object')
            control = <JsonInput id={id} value={val} onChange={(x) => set(name, x)} />;
          else if (isDateTime(name, s)) control = <Input id={id} type="datetime-local" required={req} value={toLocalInput(val)} onChange={(e) => set(name, fromLocalInput(e.target.value))} />;
          else if (isDate(name, s)) control = <Input id={id} type="date" required={req} value={val ? String(val).slice(0, 10) : ''} onChange={(e) => set(name, e.target.value || null)} />;
          else if (name === 'color') control = <div className="flex gap-2"><input type="color" className="h-9 w-12 rounded-lg ring-1 ring-black/15" value={String(val ?? '#16A34A')} onChange={(e) => set(name, e.target.value.toUpperCase())} /><Input id={id} value={String(val ?? '')} onChange={(e) => set(name, e.target.value)} /></div>;
          else if (wide && (name === 'notes' || name === 'description' || (s.maxLength ?? 0) > 300))
            control = <Textarea id={id} required={req} maxLength={s.maxLength} value={String(val ?? '')} onChange={(e) => set(name, e.target.value)} />;
          else
            control = <Input id={id} type={name.includes('email') ? 'email' : name.includes('phone') ? 'tel' : name === 'url' ? 'url' : 'text'} required={req} maxLength={s.maxLength} pattern={s.pattern} value={val === undefined || val === null ? '' : String(val)} onChange={(e) => set(name, e.target.value)} />;
          return (
            <div key={name} className={cx(wide && 'sm:col-span-2')}>
              {s.type === 'boolean' && !custom ? control : <Field label={label} htmlFor={id} required={req} hint={s.description} error={errs[name]}>{control}</Field>}
            </div>
          );
        })}
      </div>
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end gap-2 border-t border-black/[0.06] pt-4">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
        )}
        <Button type="submit" loading={busy}>
          {submitLabel ?? t('save')}
        </Button>
      </div>
    </form>
  );
}

function JsonInput({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }): ReactNode {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <Textarea
      id={id}
      rows={4}
      className={cx('font-mono text-xs', bad && 'ring-red-500')}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}
