import { requireRoles } from './radioAuth.js';

export const basicAuth = requireRoles('superadmin');
