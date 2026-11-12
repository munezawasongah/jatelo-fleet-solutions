import type { Router } from 'express';
import { z } from 'zod';
import { route } from '../http/route.js';
import { version } from '../version.js';
import { registerAuthRoutes } from './auth.js';
import { registerFileRoutes } from './files.js';
import { registerVehicleGroupRoutes } from './vehicle-groups.js';
import { registerVehicleRoutes } from './vehicles.js';
import { registerDeviceRoutes } from './devices.js';
import { registerDriverRoutes } from './drivers.js';
import { registerShiftRoutes } from './shifts.js';
import { registerTrackingRoutes } from './tracking.js';
import { registerGeoRoutes } from './geo.js';
import { registerAlertRoutes } from './alerts.js';
import { registerMaintenanceRoutes } from './maintenance.js';
import { registerFuelRoutes } from './fuel.js';
import { registerBehaviourRoutes } from './behaviour.js';

const ApiInfo = z.object({ name: z.string(), version: z.string(), docs: z.string() });

/** Registers every /api/v1 module. Each module adds its own routes here. */
export function registerV1Routes(v1: Router): void {
  route(v1, '/api/v1', {
    method: 'get',
    path: '/',
    tags: ['Meta'],
    summary: 'API information',
    responses: { 200: { description: 'API name, version and docs location', schema: ApiInfo } },
    handler: () => ({ name: 'Jatelo Fleet Solutions API', version, docs: '/api/docs' }),
  });
  registerAuthRoutes(v1);
  registerFileRoutes(v1);
  registerVehicleGroupRoutes(v1);
  registerVehicleRoutes(v1);
  registerDeviceRoutes(v1);
  registerDriverRoutes(v1);
  registerShiftRoutes(v1);
  registerTrackingRoutes(v1);
  registerGeoRoutes(v1);
  registerAlertRoutes(v1);
  registerMaintenanceRoutes(v1);
  registerFuelRoutes(v1);
  registerBehaviourRoutes(v1);
}
