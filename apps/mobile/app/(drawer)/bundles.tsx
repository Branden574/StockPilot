import { useRouter } from 'expo-router';
import * as React from 'react';

/**
 * Drawer "Bundles" entry — forwards to the existing modal stack route
 * at /bundles which already renders the bundle list. Avoids
 * duplicating routes; expo-router treats this as a passthrough.
 */
export default function BundlesDrawer() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace('/bundles');
  }, [router]);
  return null;
}
