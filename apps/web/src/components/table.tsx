import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type Page, type Query, type Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { EntityForm } from './forms';
import { Button, Card, Empty, Input, Modal, PageHeader, Spinner, StatusBadge, cx, errorText, useToast } from './ui';

export interface Column {
  key: string;
  label?: string;
  render?: (r: Row) => ReactNode;
  type?: 'text' | 'date' | 'datetime' | 'number' | 'money' | 'status' | 'bool';
  align?: 'right';
  className?: string;
}

function cell(c: Column, r: Row): ReactNode {
  if (c.render) return c.render(r);
  const v = c.key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), r);
  switch (c.type) {
    case 'date':
      return fmtDate(v);
    case 'datetime':
      return fmtDateTime(v);
    case 'number':
      return fmtNum(v, 1);
    case 'money':
      return fmtMoney(v);
    case 'status':
      return <StatusBadge value={v} />;
    case 'bool':
      return v ? '✓' : '—';
    default:
      return v === null || v === undefined || v === '' ? <span className="text-ink/30">—</span> : String(v);
  }
}

export function Table({ columns, rows, onRowClick, rowActions, loading, empty }: { columns: Column[]; rows: Row[]; onRowClick?: (r: Row) => void; rowActions?: (r: Row) => ReactNode; loading?: boolean; empty?: ReactNode }): ReactNode {
  const { f } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-black/[0.07] text-xs font-medium text-ink/55">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('whitespace-nowrap px-4 py-2.5 font-medium', (c.align === 'right' || c.type === 'number' || c.type === 'money') && 'text-right')}>
                {c.label ?? f(c.key.split('.')[0]!)}
              </th>
            ))}
            {rowActions && <th className="w-px" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={String(r.id ?? i)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cx('border-b border-black/[0.04] last:border-0', onRowClick && 'cursor-pointer hover:bg-brand-50/50')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx('px-4 py-2.5 align-middle', (c.align === 'right' || c.type === 'number' || c.type === 'money') && 'text-right tabular', c.className)}>
                  {cell(c, r)}
                </td>
              ))}
              {rowActions && (
                <td className="px-2 py-1.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {rowActions(r)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {loading && !rows.length && (
        <div className="flex justify-center py-10">
          <Spinner className="size-6 text-brand-600" />
        </div>
      )}
      {!loading && !rows.length && (empty ?? <Empty />)}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }): ReactNode {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-2.5 text-xs text-ink/60">
      <span className="tabular">{t('results', { n: total })}</span>
      <div className="flex items-center gap-2">
        <span className="tabular">{t('page_of', { page, pages })}</span>
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('previous')} icon={<ChevronLeft className="size-4" />} />
        <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('next')} icon={<ChevronRight className="size-4" />} />
      </div>
    </div>
  );
}

/** Paged list with search and filters. */
export function usePaged<T = Row>(path: string, params: Query = {}, opts: { pageSize?: number; enabled?: boolean } = {}) {
  const [page, setPage] = useState(1);
  const key = JSON.stringify(params);
  useEffect(() => setPage(1), [key]);
  const q = useQuery({
    queryKey: [path, 'list', params, page],
    queryFn: () => api.get<Page<T>>(path, { ...params, page, page_size: opts.pageSize ?? 25 }),
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
  return { ...q, page, setPage, rows: q.data?.data ?? [], total: q.data?.pagination.total ?? 0, pageSize: opts.pageSize ?? 25 };
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }): ReactNode {
  const { t } = useI18n();
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => onChange(v), 300);
    return () => clearTimeout(id);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink/40" />
      <Input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder ?? t('search')} className="pl-8" aria-label={t('search')} />
    </div>
  );
}

/**
 * Standard list + create/edit/delete page for a REST resource. Forms come from the API's OpenAPI schema.
 */
export function CrudPage({
  path,
  title,
  subtitle,
  columns,
  write,
  filters,
  params,
  formOpts,
  onRowClick,
  canDelete = true,
  canCreate = true,
  extraActions,
  headerActions,
  embedded,
  searchable = true,
  noun,
}: {
  path: string;
  title: string;
  subtitle?: string;
  columns: Column[];
  write?: string;
  filters?: ReactNode;
  params?: Query;
  formOpts?: Parameters<typeof EntityForm>[0]['opts'];
  onRowClick?: (r: Row) => void;
  canDelete?: boolean;
  canCreate?: boolean;
  extraActions?: (r: Row) => ReactNode;
  headerActions?: ReactNode;
  embedded?: boolean;
  searchable?: boolean;
  noun?: string;
}): ReactNode {
  const { t } = useI18n();
  const { can } = useAuth();
  const { toast, confirm } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const list = usePaged(path, { ...params, search: search || undefined, q: search || undefined });
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const writable = write ? can(write) : false;

  const remove = async (r: Row): Promise<void> => {
    if (!(await confirm(`${t('delete')} ${String(r.name ?? r.plate_number ?? r.full_name ?? r.title ?? '')}?`, { danger: true, label: t('delete') }))) return;
    try {
      await api.del(`${path}/${String(r.id)}`);
      toast(t('deleted'));
      await qc.invalidateQueries({ queryKey: [path] });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const body = (
    <Card pad={false}>
      {(searchable || filters) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          {searchable && <SearchBox value={search} onChange={setSearch} />}
          {filters}
        </div>
      )}
      <Table
        columns={columns}
        rows={list.rows}
        loading={list.isPending}
        onRowClick={onRowClick ?? (writable ? (r) => setEditing(r) : undefined)}
        rowActions={
          writable || extraActions
            ? (r) => (
                <div className="flex justify-end gap-0.5">
                  {extraActions?.(r)}
                  {writable && <Button variant="ghost" size="sm" aria-label={t('edit')} icon={<Pencil className="size-4" />} onClick={() => setEditing(r)} />}
                  {writable && canDelete && <Button variant="ghost" size="sm" aria-label={t('delete')} icon={<Trash2 className="size-4 text-red-600" />} onClick={() => void remove(r)} />}
                </div>
              )
            : undefined
        }
      />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </Card>
  );

  return (
    <>
      {embedded ? (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="flex gap-2">
            {headerActions}
            {writable && canCreate && <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>{t('add')}</Button>}
          </div>
        </div>
      ) : (
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            <>
              {headerActions}
              {writable && canCreate && <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>{t('add')}</Button>}
            </>
          }
        />
      )}
      {body}
      <Modal open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `${t('edit')} ${noun ?? ''}` : `${t('new')} ${noun ?? ''}`} size="lg">
        {editing !== undefined && (
          <EntityForm
            path={path}
            row={editing}
            opts={formOpts}
            onCancel={() => setEditing(undefined)}
            onSaved={() => {
              toast(t('saved'));
              setEditing(undefined);
              void qc.invalidateQueries({ queryKey: [path] });
              void qc.invalidateQueries({ queryKey: ['options'] });
            }}
          />
        )}
      </Modal>
    </>
  );
}
