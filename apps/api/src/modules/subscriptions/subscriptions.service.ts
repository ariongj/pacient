import { db, type Executor } from '../../db/client.js';

/**
 * Refuses a new (or re-enabled) staff account when the facility has used all seats of its
 * subscription. Never affects existing accounts or clinical access.
 */
export async function assertSeatAvailable(
  _facilityId: string,
  _executor: Executor = db,
): Promise<void> {
  // Implemented with the subscriptions module.
}

/** Daily subscription lifecycle (renewals, invoices, overdue, grace, reminders). */
export function startSubscriptionsWorker() {}
export function stopSubscriptionsWorker() {}
