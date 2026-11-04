import { generateDowntimePacks } from '../modules/downtime/downtime.service.js';

/**
 * Demo data for this module (development seed only): one downtime pack for the demo hospital so
 * the Downtime kit page has something to show. The hourly worker keeps it fresh afterwards.
 */
export async function seedDowntime({ facilityId }: { facilityId: string }) {
  try {
    await generateDowntimePacks(facilityId, new Date());
  } catch (err) {
    console.warn('Downtime pack not generated during seed:', (err as Error).message);
  }
}
