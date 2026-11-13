import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import { registerSW } from 'virtual:pwa-register';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider } from './lib/i18n';
import { AcceptInvite, ForgotPassword, Login, MfaSetupPage, ResetPassword } from './pages/auth';
import './styles.css';

const Dashboard = lazy(() => import('./pages/dashboard'));
const LiveMap = lazy(() => import('./pages/live-map'));
const VehiclePage = lazy(() => import('./pages/vehicles').then((m) => ({ default: m.VehiclesPage })));
const VehicleDetail = lazy(() => import('./pages/vehicles').then((m) => ({ default: m.VehicleDetail })));
const DriversPage = lazy(() => import('./pages/drivers').then((m) => ({ default: m.DriversPage })));
const DriverDetail = lazy(() => import('./pages/drivers').then((m) => ({ default: m.DriverDetail })));
const DevicesPage = lazy(() => import('./pages/devices'));
const TripsPage = lazy(() => import('./pages/trips'));
const GeofencesPage = lazy(() => import('./pages/geofences'));
const AlertsPage = lazy(() => import('./pages/alerts'));
const MaintenancePage = lazy(() => import('./pages/maintenance'));
const FuelPage = lazy(() => import('./pages/fuel'));
const DispatchPage = lazy(() => import('./pages/dispatch').then((m) => ({ default: m.DispatchBoard })));
const JobDetail = lazy(() => import('./pages/dispatch').then((m) => ({ default: m.JobDetail })));
const JobEditor = lazy(() => import('./pages/dispatch').then((m) => ({ default: m.JobEditor })));
const MessagesPage = lazy(() => import('./pages/messages'));
const ReportsPage = lazy(() => import('./pages/reports'));
const BillingPage = lazy(() => import('./pages/billing'));
const SettingsPage = lazy(() => import('./pages/settings'));
const AccountPage = lazy(() => import('./pages/account'));
const AdminHome = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminHome })));
const AdminTenants = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminTenants })));
const AdminTenantDetail = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminTenantDetail })));
const AdminPlans = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminPlans })));
const AdminInvoices = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminInvoices })));
const AdminDevices = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminDevices })));
const AdminAudit = lazy(() => import('./pages/admin').then((m) => ({ default: m.AdminAudit })));
const TrackShare = lazy(() => import('./pages/track-share'));

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => n < 2 && !(err instanceof ApiError && err.status < 500),
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

function Loading(): ReactNode {
  return (
    <div className="flex h-full min-h-60 items-center justify-center">
      <Spinner className="size-7 text-brand-600" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { ready, me } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.mfa_setup_required && loc.pathname !== '/setup-2fa') return <Navigate to="/setup-2fa" replace />;
  return children;
}

function Home(): ReactNode {
  const { me, can } = useAuth();
  if (me?.user.role === 'super_admin') return <Navigate to="/admin" replace />;
  if (me?.user.role === 'driver') return <DriverOnly />;
  if (!can('analytics:read')) return <Navigate to={can('tracking:read') ? '/map' : can('jobs:read') ? '/dispatch' : can('maintenance:read') ? '/maintenance' : '/account'} replace />;
  return <Dashboard />;
}

function DriverOnly(): ReactNode {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <img src="/favicon.svg" alt="" className="mx-auto mb-4 size-14" />
      <h1 className="text-lg font-semibold">Jatelo Fleet Driver</h1>
      <p className="mt-2 text-sm text-ink/60">Drivers use the Jatelo Fleet Driver app on Android for jobs, shifts, inspections, fuel and messages.</p>
    </div>
  );
}

const S = (el: ReactNode): ReactNode => <Suspense fallback={<Loading />}>{el}</Suspense>;

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },
  { path: '/accept-invite', element: <AcceptInvite /> },
  { path: '/share/:token', element: S(<TrackShare />) },
  { path: '/setup-2fa', element: <RequireAuth><MfaSetupPage /></RequireAuth> },
  {
    path: '/',
    element: <RequireAuth><Layout /></RequireAuth>,
    children: [
      { index: true, element: S(<Home />) },
      { path: 'map', element: S(<LiveMap />) },
      { path: 'vehicles', element: S(<VehiclePage />) },
      { path: 'vehicles/:id', element: S(<VehicleDetail />) },
      { path: 'drivers', element: S(<DriversPage />) },
      { path: 'drivers/:id', element: S(<DriverDetail />) },
      { path: 'devices', element: S(<DevicesPage />) },
      { path: 'trips', element: S(<TripsPage />) },
      { path: 'geofences', element: S(<GeofencesPage />) },
      { path: 'alerts', element: S(<AlertsPage />) },
      { path: 'maintenance', element: S(<MaintenancePage />) },
      { path: 'fuel', element: S(<FuelPage />) },
      { path: 'dispatch', element: S(<DispatchPage />) },
      { path: 'dispatch/new', element: S(<JobEditor />) },
      { path: 'dispatch/:id', element: S(<JobDetail />) },
      { path: 'messages', element: S(<MessagesPage />) },
      { path: 'reports', element: S(<ReportsPage />) },
      { path: 'billing', element: S(<BillingPage />) },
      { path: 'settings', element: S(<SettingsPage />) },
      { path: 'account', element: S(<AccountPage />) },
      { path: 'admin', element: S(<AdminHome />) },
      { path: 'admin/tenants', element: S(<AdminTenants />) },
      { path: 'admin/tenants/:id', element: S(<AdminTenantDetail />) },
      { path: 'admin/plans', element: S(<AdminPlans />) },
      { path: 'admin/invoices', element: S(<AdminInvoices />) },
      { path: 'admin/devices', element: S(<AdminDevices />) },
      { path: 'admin/audit', element: S(<AdminAudit />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
