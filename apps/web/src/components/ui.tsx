import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useI18n } from '../lib/i18n';

export const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- buttons
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary: 'bg-white text-ink ring-1 ring-inset ring-black/10 hover:bg-black/[0.03] shadow-sm',
  ghost: 'text-ink/80 hover:bg-black/5',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  accent: 'bg-accent-500 text-brand-950 hover:bg-accent-400 shadow-sm',
};
export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return <span aria-hidden className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', className ?? 'size-5')} />;
}

// ---------------------------------------------------------------- form controls
const control =
  'w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink ring-1 ring-inset ring-black/15 placeholder:text-ink/40 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:bg-black/[0.03]';

export function Field({ label, hint, error, required, children, htmlFor }: { label?: string; hint?: string; error?: string; required?: boolean; children: ReactNode; htmlFor?: string }): ReactNode {
  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink/80">
          {label}
          {required && <span className="text-red-600"> *</span>}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-ink/50">{hint}</p> : null}
    </div>
  );
}
/** Base control classes; an explicit width in className replaces the default full width. */
const base = (className?: string): string => (className && /(^|\s)w-/.test(className) ? control.replace('w-full ', '') : control);
export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...props} className={cx(base(props.className), /(^|\s)h-\d/.test(props.className ?? '') ? '' : 'h-9', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea rows={3} {...props} className={cx(base(props.className), props.className)} />;
}
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select {...props} className={cx(base(props.className), /(^|\s)h-\d/.test(props.className ?? '') ? '' : 'h-9', 'pr-8', props.className)}>
      {children}
    </select>
  );
}
export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }): ReactNode {
  const id = useId();
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input id={id} type="checkbox" {...props} className="size-4 rounded border-black/20 accent-brand-600" />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- layout atoms
export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }): ReactNode {
  return (
    <section className={cx('rounded-xl bg-white shadow-sm ring-1 ring-black/[0.06]', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink/60">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  gray: 'bg-black/[0.04] text-ink/70 ring-black/10',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};
const STATUS_TONE: Record<string, string> = {
  active: 'green', moving: 'green', completed: 'green', paid: 'green', resolved: 'green', ok: 'green', succeeded: 'green', acknowledged: 'blue',
  idle: 'amber', warning: 'amber', due: 'amber', pending: 'amber', scheduled: 'blue', dispatched: 'blue', in_progress: 'violet', en_route: 'violet',
  arrived: 'violet', trial: 'blue', trialing: 'blue', open: 'amber', invited: 'blue', draft: 'gray', stopped: 'gray', inactive: 'gray', never: 'gray',
  offline: 'red', critical: 'red', overdue: 'red', failed: 'red', suspended: 'red', cancelled: 'gray', disabled: 'gray', info: 'blue', major: 'amber',
  minor: 'gray', urgent: 'red', high: 'amber', normal: 'gray', low: 'gray', expiring_soon: 'amber', expired: 'red', void: 'gray', skipped: 'gray',
  in_maintenance: 'amber', in_stock: 'gray', queued: 'amber', sent: 'blue', past_due: 'red', sold: 'gray', written_off: 'gray', deferred: 'gray',
};
export function Badge({ tone, children }: { tone?: string; children: ReactNode }): ReactNode {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', TONES[tone ?? 'gray'])}>{children}</span>;
}
export function StatusBadge({ value }: { value: unknown }): ReactNode {
  const { t } = useI18n();
  if (value === null || value === undefined || value === '') return <span className="text-ink/40">—</span>;
  const v = String(value);
  return <Badge tone={STATUS_TONE[v] ?? 'gray'}>{t(v)}</Badge>;
}

export function Empty({ title, children, icon }: { title?: string; children?: ReactNode; icon?: ReactNode }): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-ink/30">{icon}</div>}
      <p className="text-sm font-medium text-ink/70">{title ?? t('no_data')}</p>
      {children && <div className="text-sm text-ink/50">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[] }): ReactNode {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-black/10">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          type="button"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={cx(
            '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === i.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink/60 hover:text-ink',
          )}
        >
          {i.label}
          {i.count !== undefined && <span className="rounded-full bg-black/5 px-1.5 text-xs tabular">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' | 'flat' }): ReactNode {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/[0.06]">
      <p className="text-xs font-medium text-ink/55">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular">{value}</p>
      {sub && <p className={cx('mt-0.5 text-xs tabular', tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-600' : 'text-ink/50')}>{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- modal
export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-2xl bg-white p-0 shadow-2xl backdrop:bg-brand-950/40 backdrop:backdrop-blur-[2px]', w)}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col">
          <header className="flex items-center justify-between border-b border-black/[0.06] px-5 py-3.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-ink/50 hover:bg-black/5 hover:text-ink" aria-label="Close">
              <X className="size-5" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-black/[0.06] bg-black/[0.015] px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- toasts & confirm
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<{ toast: (text: string, tone?: 'ok' | 'error') => void; confirm: (text: string, opts?: { danger?: boolean; label?: string }) => Promise<boolean> } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<{ text: string; danger?: boolean; label?: string; resolve: (b: boolean) => void } | null>(null);
  const { t } = useI18n();
  const toast = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, text, tone }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  const confirm = useCallback((text: string, opts?: { danger?: boolean; label?: string }) => new Promise<boolean>((resolve) => setAsk({ text, ...opts, resolve })), []);
  const answer = (b: boolean): void => {
    ask?.resolve(b);
    setAsk(null);
  };
  return (
    <ToastCtx.Provider value={{ toast, confirm }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[2000] flex flex-col items-center gap-2 px-4">
        {toasts.map((x) => (
          <div key={x.id} className={cx('pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm shadow-lg', x.tone === 'error' ? 'bg-red-700 text-white' : 'bg-brand-900 text-white')}>
            {x.text}
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(ask)}
        onClose={() => answer(false)}
        title={t('are_you_sure')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => answer(false)}>
              {t('cancel')}
            </Button>
            <Button variant={ask?.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
              {ask?.label ?? t('confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink/80">{ask?.text}</p>
      </Modal>
    </ToastCtx.Provider>
  );
}
export function useToast(): { toast: (text: string, tone?: 'ok' | 'error') => void; confirm: (text: string, opts?: { danger?: boolean; label?: string }) => Promise<boolean> } {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}

export function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { message: string; details?: unknown };
    if (Array.isArray(e.details) && e.details.length)
      return `${e.message}: ${(e.details as { path?: string; message?: string }[]).map((i) => `${i.path ? `${i.path} - ` : ''}${i.message ?? ''}`).join('; ')}`;
    return e.message;
  }
  return String(err);
}

/** Field-level errors from a 422 response, keyed by top-level field. */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const d = (err as { details?: unknown } | null)?.details;
  if (Array.isArray(d)) for (const i of d as { path?: string; message?: string }[]) if (i.path) out[String(i.path).split('.')[0]!] ??= i.message ?? '';
  return out;
}
