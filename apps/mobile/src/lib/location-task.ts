import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { api } from './api';

export const LIVE_LOCATION_TASK = 'stockpilot-live-location';
const ORDER_KEY = 'liveTracking.orderId';

interface LocationTaskBody {
  locations?: Location.LocationObject[];
}

// Background task: on each batch, POST the latest fix for the active order.
// Best-effort; a 4xx (order no longer in_transit / not the assigned driver /
// module off) self-stops so a stale task can't keep firing.
TaskManager.defineTask(LIVE_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const orderId = await AsyncStorage.getItem(ORDER_KEY);
  if (!orderId) {
    await stopLiveLocation();
    return;
  }
  const locs = (data as LocationTaskBody)?.locations ?? [];
  const last = locs[locs.length - 1];
  if (!last) return;
  try {
    await api('/api/v1/delivery/location', {
      method: 'POST',
      body: {
        orderId,
        lat: last.coords.latitude,
        lng: last.coords.longitude,
        heading:
          last.coords.heading != null && last.coords.heading >= 0 ? last.coords.heading : undefined,
        accuracy: last.coords.accuracy ?? undefined,
      },
    });
  } catch (e) {
    // 4xx = order ended / not assigned / module off → stop. Other errors
    // (transient network) → keep trying on the next OS tick.
    if (e instanceof Error && /API 4\d\d/.test(e.message)) {
      await stopLiveLocation();
    }
  }
});

export async function isLiveLocationActive(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK);
  } catch {
    return false;
  }
}

export async function startLiveLocation(orderId: string): Promise<void> {
  await AsyncStorage.setItem(ORDER_KEY, orderId);
  if (await isLiveLocationActive()) return;
  await Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 12_000,
    distanceInterval: 25,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Sharing your delivery location',
      notificationBody: 'The customer can see you on the map until this delivery is complete.',
    },
  });
}

export async function stopLiveLocation(): Promise<void> {
  await AsyncStorage.removeItem(ORDER_KEY);
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK);
    }
  } catch {
    /* not started — nothing to stop */
  }
}
