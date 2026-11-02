import net from 'node:net';
import { env, isProd } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/** Result of a malware scan. `null` from a scanner means no scanner is configured. */
export type ScanResult = { clean: true } | { clean: false; signature: string };
export type Scanner = (content: Buffer) => Promise<ScanResult>;

/**
 * clamd INSTREAM over TCP: "zINSTREAM\0", then chunks prefixed with a 4-byte big-endian length,
 * terminated by a zero-length chunk. The daemon answers "stream: OK" or "stream: <name> FOUND".
 */
export function clamavScanner(host: string, port: number, timeoutMs = 30_000): Scanner {
  return (content) =>
    new Promise<ScanResult>((resolve, reject) => {
      const socket = net.connect({ host, port });
      let reply = '';
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => fail(new Error('Malware scanner timed out')));
      socket.on('error', fail);
      socket.on('data', (d) => {
        reply += d.toString('utf8');
      });
      socket.on('end', () => {
        const text = reply.replace(/\0/g, '').trim();
        if (/^stream: OK$/.test(text)) resolve({ clean: true });
        else if (/FOUND$/.test(text))
          resolve({
            clean: false,
            signature: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''),
          });
        else reject(new Error(`Unexpected scanner reply: ${text.slice(0, 120)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < content.length; i += CHUNK) {
          const part = content.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // end of stream
      });
    });
}

let scanner: Scanner | null =
  env.DOCUMENT_SCANNER === 'clamav' ? clamavScanner(env.CLAMAV_HOST!, env.CLAMAV_PORT) : null;

if (!scanner && isProd) {
  logger.warn(
    'Document malware scanning is off (DOCUMENT_SCANNER=off); uploads are stored as NOT_SCANNED',
  );
}

export const getScanner = () => scanner;

/** Tests replace the scanner (e.g. to simulate an infected upload); pass null to disable. */
export function setScannerForTests(s: Scanner | null) {
  scanner = s;
}
