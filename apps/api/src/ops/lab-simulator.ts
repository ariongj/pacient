/**
 * Development laboratory simulator: behaves like a laboratory information system connected to
 * Pacient. It pulls new orders, marks them received and posts plausible ORU^R01 results
 * (occasionally abnormal or critical).
 *
 *   LAB_API_KEY=pk_… npm run lab:simulate            (once)
 *   LAB_API_KEY=pk_… npm run lab:simulate -- --watch (every 15 s)
 *
 * Never point it at a production system.
 */
import { catalogByCode } from '../modules/lab/catalog.js';
import { buildOru } from './oru.js';

const base = (process.env.PACIENT_API ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
const key = process.env.LAB_API_KEY;
if (!key) {
  console.error('Set LAB_API_KEY to the key shown when the laboratory connection was created.');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${key}` };

interface PulledOrder {
  placerOrderNumber: string;
  test: { code: string; name: string };
  priority: string;
  patient: {
    nationalId: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
  };
}

/** Clinically plausible critical values for the tests where a critical call is meaningful. */
const CRITICAL: Record<string, { value: number; flag: 'HH' | 'LL' }> = {
  '2823-3': { value: 6.6, flag: 'HH' }, // potassium
  '2345-7': { value: 2.4, flag: 'LL' }, // glucose
  '718-7': { value: 62, flag: 'LL' }, // haemoglobin
  '2951-2': { value: 118, flag: 'LL' }, // sodium
};

function simulatedValue(code: string): {
  value: string;
  flag: string;
  unit: string;
  range: string;
} {
  const t = catalogByCode(code);
  if (!t) return { value: 'Negative', flag: 'N', unit: '', range: '' };
  const [lo, hi] = t.normal;
  const r = Math.random();
  let v: number;
  let flag = 'N';
  const critical = CRITICAL[code];
  if (critical && r < 0.06) {
    v = critical.value;
    flag = critical.flag;
  } else if (r < 0.25) {
    v = hi + (hi - lo) * (0.1 + Math.random() * 0.3);
    flag = 'H';
  } else if (r < 0.32) {
    v = lo - (hi - lo) * (0.05 + Math.random() * 0.2);
    flag = 'L';
  } else {
    v = lo + (hi - lo) * Math.random();
  }
  return { value: Math.max(0, v).toFixed(t.decimals), flag, unit: t.unit, range: t.referenceRange };
}

async function runOnce() {
  const res = await fetch(`${base}/integrations/lab/orders`, { headers });
  if (!res.ok) throw new Error(`Pulling orders failed: ${res.status} ${await res.text()}`);
  const { items } = (await res.json()) as { items: PulledOrder[] };
  if (!items.length) {
    console.log('No new orders.');
    return;
  }
  for (const order of items) {
    const filler = `LAB${Math.floor(Math.random() * 1e6)}`;
    await fetch(`${base}/integrations/lab/orders/${order.placerOrderNumber}/receive`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fillerOrderNumber: filler }),
    });
    const sim = simulatedValue(order.test.code);
    const oru = buildOru({
      controlId: `SIM${Date.now()}${Math.floor(Math.random() * 1000)}`,
      placerOrderNumber: order.placerOrderNumber,
      fillerOrderNumber: filler,
      patient: order.patient,
      observations: [
        {
          code: order.test.code,
          name: order.test.name,
          value: sim.value,
          unit: sim.unit,
          referenceRange: sim.range,
          flag: sim.flag,
        },
      ],
    });
    const post = await fetch(`${base}/integrations/lab/results`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/hl7-v2' },
      body: oru,
    });
    const ack = await post.text();
    const msa = ack.split('\r').find((s) => s.startsWith('MSA')) ?? '';
    console.log(
      `${order.placerOrderNumber} ${order.test.name}: ${sim.value} ${sim.unit} [${sim.flag}] → ${post.headers.get('x-pacient-status')} (${msa})`,
    );
  }
}

const watch = process.argv.includes('--watch');
await runOnce();
if (watch) {
  console.log('Watching for new orders every 15 s (Ctrl+C to stop)…');
  setInterval(() => {
    runOnce().catch((err: unknown) => console.error(err));
  }, 15_000);
}
