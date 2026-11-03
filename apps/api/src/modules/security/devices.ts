import { createHash } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { knownDevices, type Role } from '../../db/schema.js';
import type { RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { AuditAction, auditSafe } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/** Coarse browser/OS detection for showing devices to their owner – not for security decisions. */
export function parseUserAgent(ua: string | null | undefined): { browser: string; os: string } {
  const s = ua ?? '';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /SamsungBrowser\//.test(s)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(s)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(s)
            ? 'Chrome'
            : /Safari\//.test(s)
              ? 'Safari'
              : s
                ? 'Browser'
                : 'Unknown browser';
  const os = /Windows/.test(s)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(s)
      ? 'iOS'
      : /Android/.test(s)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(s)
          ? 'macOS'
          : /CrOS/.test(s)
            ? 'ChromeOS'
            : /Linux/.test(s)
              ? 'Linux'
              : 'Unknown system';
  return { browser, os };
}

/** "Chrome on Windows" (English source text; the web app translates the connective). */
export function deviceLabel(ua: string | null | undefined): string {
  const { browser, os } = parseUserAgent(ua);
  return `${browser} · ${os}`;
}

/** IPv4 192.168.1.x / IPv6 2001:db8:1::x – enough for the owner to recognise a network. */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.x`;
  const groups = ip.split(':').filter(Boolean).slice(0, 3);
  return groups.length ? `${groups.join(':')}::x` : null;
}

/** Network prefix used for device recognition: IPv4 /24, IPv6 /48. */
function network(ip: string | null | undefined): string {
  if (!ip) return '';
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split('.').slice(0, 3).join('.');
  return ip.split(':').slice(0, 3).join(':');
}

export function deviceHash(meta: RequestMeta): string {
  const { browser, os } = parseUserAgent(meta.userAgent);
  return createHash('sha256')
    .update(`${browser}|${os}|${network(meta.ipAddress)}`)
    .digest('hex');
}

/**
 * Remembers the device of a successful sign-in. A sign-in from a device (browser, system and
 * network) the user has not used before triggers an important notification – except for the
 * account's very first device. Never throws: a failure here must not block signing in.
 */
export async function noteSignInDevice(
  user: { id: string; role: Role; facilityId: string | null },
  meta: RequestMeta,
) {
  try {
    const hash = deviceHash(meta);
    const label = deviceLabel(meta.userAgent);
    const [existing] = await db
      .select({ id: knownDevices.id })
      .from(knownDevices)
      .where(and(eq(knownDevices.userId, user.id), eq(knownDevices.deviceHash, hash)));
    if (existing) {
      await db
        .update(knownDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(knownDevices.id, existing.id));
      return { newDevice: false };
    }
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(knownDevices)
      .where(eq(knownDevices.userId, user.id));
    const inserted = await db
      .insert(knownDevices)
      .values({ userId: user.id, deviceHash: hash, label })
      .onConflictDoNothing()
      .returning({ id: knownDevices.id });
    if (!inserted.length || n === 0) return { newDevice: false };

    const ip = maskIp(meta.ipAddress) ?? '—';
    await notifyUsers([user.id], {
      type: 'security',
      title: 'New sign-in to your Pacient account',
      body: 'A sign-in from {device} (network {ip}) on {time}. If this was not you, change your password and sign out all other devices under Account › Security.',
      vars: { device: label, ip, time: new Date() },
      link: '/account/security',
      important: true,
    });
    await auditSafe({
      action: AuditAction.NEW_DEVICE_SIGN_IN,
      actor: { userId: user.id, role: user.role, facilityId: user.facilityId },
      meta,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { device: label, network: ip },
    });
    return { newDevice: true };
  } catch (err) {
    logger.warn({ err }, 'Could not record the sign-in device');
    return { newDevice: false };
  }
}
