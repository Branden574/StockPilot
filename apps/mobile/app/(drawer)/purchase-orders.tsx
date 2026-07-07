/**
 * Drawer route for Purchase orders — thin wrapper over the shared screen so the
 * optional bottom tab (app/(drawer)/(tabs)/purchase-orders-tab.tsx) renders the
 * exact same component without duplicating screen code. This route's path
 * (/purchase-orders) and behavior are unchanged.
 */
export { default } from '@/screens/purchase-orders';
