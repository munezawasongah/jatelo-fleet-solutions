import { useMutation } from '@tanstack/react-query';
import { Languages, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input, Spinner, errorText } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

function Shell({ title, sub, children }: { title: string; sub?: string; children: ReactNode }): ReactNode {
  const { lang, setLang } = useI18n();
  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-brand-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <span className="text-lg font-semibold">Jatelo Fleet Solutions</span>
        </div>
        <div className="relative z-10 max-w-md">
          <p className="text-3xl font-semibold leading-tight tracking-tight">Every vehicle, every trip, every shilling — in one place.</p>
          <p className="mt-4 text-white/60">Live GPS tracking, dispatch, maintenance, fuel control and driver safety for fleets in Kenya, Tanzania, Uganda and Rwanda.</p>
        </div>
        <p className="text-xs text-white/40">© {new Date().getFullYear()} Jatelo Technologies · Kisumu, Kenya</p>
        <svg className="absolute -right-24 bottom-10 w-[34rem] opacity-[0.13]" viewBox="0 0 400 300" aria-hidden>
          <path d="M10 250 C 80 140, 140 220, 210 120 S 330 60, 390 30" stroke="#F5B83D" strokeWidth="6" fill="none" strokeDasharray="2 14" strokeLinecap="round" />
          <circle cx="210" cy="120" r="10" fill="#F5B83D" />
          <circle cx="390" cy="30" r="14" fill="#F5B83D" />
        </svg>
      </div>
      <div className="flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between lg:justify-end">
            <img src="/favicon.svg" alt="" className="size-10 lg:hidden" />
            <Button variant="ghost" size="sm" icon={<Languages className="size-4" />} onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}>
              {lang === 'en' ? 'Kiswahili' : 'English'}
            </Button>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {sub && <p className="mt-1 text-sm text-ink/60">{sub}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: unknown }): ReactNode {
  return error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errorText(error)}</p> : null;
}

export function Login(): ReactNode {
  const { t } = useI18n();
  const { login, loginMfa, me, ready } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  const m = useMutation({
    mutationFn: async () => {
      if (mfaToken) {
        await loginMfa(mfaToken, code);
        return;
      }
      const r = await login(email, password);
      if (!r.ok) setMfaToken(r.mfaToken);
      else nav(r.mfaSetup ? '/setup-2fa' : from, { replace: true });
    },
    onSuccess: () => {
      if (mfaToken) nav(from, { replace: true });
    },
  });
  if (ready && me) return <Navigate to={from} replace />;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Shell title={mfaToken ? t('verification_code') : t('welcome_back')} sub={mfaToken ? t('enter_code') : t('sign_in_sub')}>
      <form onSubmit={submit} className="space-y-4">
        {!mfaToken ? (
          <>
            <Field label={t('email')} htmlFor="email">
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <Field label={t('password')} htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field label={t('verification_code')} htmlFor="code" hint="Backup codes work here too.">
            <Input id="code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.trim())} autoFocus className="text-center text-lg tracking-[0.4em]" />
          </Field>
        )}
        <ErrorBox error={m.error} />
        <Button type="submit" className="w-full" loading={m.isPending}>
          {mfaToken ? t('confirm') : t('sign_in')}
        </Button>
        {!mfaToken && (
          <p className="text-center text-sm">
            <Link to="/forgot-password" className="font-medium text-brand-700 hover:underline">
              {t('forgot_password')}
            </Link>
          </p>
        )}
      </form>
    </Shell>
  );
}

export function ForgotPassword(): ReactNode {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/auth/password/forgot', { email }) });
  return (
    <Shell title={t('reset_password')}>
      {m.isSuccess ? (
        <p className="rounded-lg bg-brand-50 px-3 py-3 text-sm text-brand-800">{t('reset_link_sent')}</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
          <Field label={t('email')} htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <ErrorBox error={m.error} />
          <Button type="submit" className="w-full" loading={m.isPending}>{t('send')}</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link to="/login" className="font-medium text-brand-700 hover:underline">{t('back')}</Link></p>
    </Shell>
  );
}

function PasswordForm({ endpoint, title }: { endpoint: string; title: string }): ReactNode {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { acceptTokens } = useAuth();
  const nav = useNavigate();
  const m = useMutation({
    mutationFn: async () => {
      if (pw !== pw2) throw new Error('The passwords do not match');
      const r = await api.post<{ access_token?: string; refresh_token?: string; mfa_setup_required?: boolean }>(endpoint, { token, password: pw });
      if (r?.access_token) {
        await acceptTokens(r as { access_token: string; refresh_token: string });
        nav(r.mfa_setup_required ? '/setup-2fa' : '/', { replace: true });
      } else nav('/login', { replace: true });
    },
  });
  return (
    <Shell title={title} sub="At least 10 characters, with letters and numbers.">
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-4">
        <Field label={t('new_password')} htmlFor="pw">
          <Input id="pw" type="password" autoComplete="new-password" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        <Field label={t('confirm')} htmlFor="pw2">
          <Input id="pw2" type="password" autoComplete="new-password" minLength={10} required value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        <ErrorBox error={m.error ?? (!token ? new Error('This link is missing its token') : null)} />
        <Button type="submit" className="w-full" loading={m.isPending} disabled={!token}>{t('save')}</Button>
      </form>
    </Shell>
  );
}
export const ResetPassword = (): ReactNode => <PasswordForm endpoint="/auth/password/reset" title={useI18n().t('reset_password')} />;
export const AcceptInvite = (): ReactNode => <PasswordForm endpoint="/auth/invite/accept" title={useI18n().t('accept_invite')} />;

/** Turns on TOTP 2FA (mandatory for administrators) and shows the backup codes once. */
export function MfaSetup({ onDone }: { onDone: () => void }): ReactNode {
  const { t } = useI18n();
  const { acceptTokens } = useAuth();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const setup = useMutation({ mutationFn: () => api.post<{ secret: string; otpauth_url: string; qr_data_url: string }>('/auth/mfa/setup') });
  useEffect(() => setup.mutate(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const enable = useMutation({
    mutationFn: () => api.post<{ access_token: string; refresh_token: string; backup_codes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: async (r) => {
      setCodes(r.backup_codes);
      await acceptTokens(r);
    },
  });
  if (codes)
    return (
      <div className="space-y-4">
        <p className="text-sm text-ink/70">{t('backup_codes_sub')}</p>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-black/[0.03] p-4 font-mono text-sm">
          {codes.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}>Copy</Button>
          <Button className="flex-1" onClick={onDone}>{t('next')}</Button>
        </div>
      </div>
    );
  return (
    <div className="space-y-4">
      {setup.isPending && <div className="flex justify-center py-8"><Spinner /></div>}
      <ErrorBox error={setup.error} />
      {setup.data && (
        <>
          <img src={setup.data.qr_data_url} alt="2FA QR code" className="mx-auto size-48 rounded-lg ring-1 ring-black/10" />
          <p className="break-all text-center font-mono text-xs text-ink/60">{setup.data.secret}</p>
          <form onSubmit={(e) => { e.preventDefault(); enable.mutate(); }} className="space-y-3">
            <Field label={t('verification_code')} htmlFor="totp">
              <Input id="totp" inputMode="numeric" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value.trim())} className="text-center text-lg tracking-[0.4em]" />
            </Field>
            <ErrorBox error={enable.error} />
            <Button type="submit" className="w-full" loading={enable.isPending} icon={<ShieldCheck className="size-4" />}>{t('confirm')}</Button>
          </form>
        </>
      )}
    </div>
  );
}

export function MfaSetupPage(): ReactNode {
  const { t } = useI18n();
  const nav = useNavigate();
  const { reload } = useAuth();
  return (
    <Shell title={t('setup_2fa')} sub={t('setup_2fa_sub')}>
      <MfaSetup onDone={() => void reload().then(() => nav('/', { replace: true }))} />
    </Shell>
  );
}
