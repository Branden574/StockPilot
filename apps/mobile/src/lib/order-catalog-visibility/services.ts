import { api } from '../api';
import { createOrderCatalogManageApi } from './api';

/**
 * Manage order items' three calls, wired to the app's api() (each with the
 * workspace header and asUserId: lib/api.ts). Kept apart from api.ts so the
 * pure module is tested without the app's network and storage modules.
 */
export const orderCatalogManageApi = createOrderCatalogManageApi((path, opts) => api(path, opts));
