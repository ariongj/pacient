import { createHmac } from 'node:crypto';
import { env } from '../../config/env.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const TURN_TTL_SECONDS = 3600;

/**
 * ICE servers for a participant. TURN credentials follow the coturn "REST API" scheme
 * (use-auth-secret): username "<unix expiry>:<user>", password base64(HMAC-SHA1(secret, username)),
 * so no long-lived TURN password ever reaches a browser.
 */
export function iceServersFor(userId: string, now = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  const stun = env.WEBRTC_STUN_URLS.split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (stun.length) servers.push({ urls: stun });
  if (env.WEBRTC_TURN_URL && env.WEBRTC_TURN_SECRET) {
    const expiry = Math.floor(now / 1000) + TURN_TTL_SECONDS;
    const username = `${expiry}:${env.WEBRTC_TURN_USERNAME ?? userId}`;
    const credential = createHmac('sha1', env.WEBRTC_TURN_SECRET).update(username).digest('base64');
    servers.push({
      urls: env.WEBRTC_TURN_URL.split(',')
        .map((u) => u.trim())
        .filter(Boolean),
      username,
      credential,
    });
  }
  return servers;
}
