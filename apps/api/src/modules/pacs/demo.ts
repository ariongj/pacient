import { createHash } from 'node:crypto';
import { drawText, textWidth } from './font.js';
import { encodeGrayPng } from './png.js';
import type { ImageSeries, WindowSetting } from './types.js';

/**
 * Built-in development PACS: deterministic synthetic studies so the viewer can be tried without a
 * real archive. Images are generated, clearly watermarked and never derived from real patients.
 */
export const DEMO_SIZE = 512;

export function demoStudyUid(accessionNumber: string): string {
  const digest = createHash('sha256').update(`pacient-demo:${accessionNumber}`).digest();
  // 2.25.<128-bit integer> is the DICOM convention for UUID-derived UIDs.
  return `2.25.${BigInt(`0x${digest.subarray(0, 16).toString('hex')}`).toString()}`;
}

interface SeriesPlan {
  description: string;
  count: number;
  /** Variant used by the renderer (e.g. MRI weighting). */
  variant: string;
}

const isHead = (bodyPart: string) => /head|skull|brain|kok|tru|kranij|glav|mozak/i.test(bodyPart);
const isLimb = (bodyPart: string) =>
  /hand|arm|leg|knee|ankle|foot|wrist|dor|kemb|këmb|gju|shuk|krah|ruk|nog|kolen|zglob/i.test(
    bodyPart,
  );

function plan(modality: string, bodyPart: string): SeriesPlan[] {
  switch (modality) {
    case 'CT':
      return [
        { description: 'Axial 5 mm', count: 36, variant: 'axial' },
        { description: 'Axial 2 mm', count: 24, variant: 'axial' },
      ];
    case 'MRI':
      return [
        { description: 'T1 axial', count: 20, variant: 'T1' },
        { description: 'T2 axial', count: 20, variant: 'T2' },
        { description: 'FLAIR axial', count: 16, variant: 'FLAIR' },
      ];
    case 'ULTRASOUND':
      return [{ description: 'B-mode', count: 6, variant: 'bmode' }];
    case 'MAMMOGRAPHY':
      return [
        { description: 'CC', count: 1, variant: 'cc' },
        { description: 'MLO', count: 1, variant: 'mlo' },
      ];
    case 'FLUOROSCOPY':
      return [{ description: 'Fluoroscopy run', count: 8, variant: 'fluoro' }];
    default:
      return isLimb(bodyPart) || isHead(bodyPart)
        ? [
            { description: 'AP', count: 1, variant: 'ap' },
            { description: 'Lateral', count: 1, variant: 'lat' },
          ]
        : [
            { description: 'PA', count: 1, variant: 'pa' },
            { description: 'Lateral', count: 1, variant: 'lat' },
          ];
  }
}

export function demoSeries(studyUid: string, modality: string, bodyPart: string): ImageSeries[] {
  return plan(modality, bodyPart).map((p, s) => {
    const seriesUid = `${studyUid}.${s + 1}`;
    return {
      uid: seriesUid,
      number: s + 1,
      description: p.description,
      modality:
        modality === 'XRAY'
          ? 'DX'
          : modality === 'ULTRASOUND'
            ? 'US'
            : modality === 'MAMMOGRAPHY'
              ? 'MG'
              : modality === 'FLUOROSCOPY'
                ? 'RF'
                : modality === 'MRI'
                  ? 'MR'
                  : 'CT',
      instances: Array.from({ length: p.count }, (_, i) => ({
        uid: `${seriesUid}.${i + 1}`,
        number: i + 1,
      })),
    };
  });
}

/** Default window per modality, and named presets offered by the viewer. */
export function windowPresets(modality: string): { key: string; window: WindowSetting }[] {
  switch (modality) {
    case 'CT':
      return [
        { key: 'soft-tissue', window: { width: 400, level: 40 } },
        { key: 'lung', window: { width: 1500, level: -600 } },
        { key: 'bone', window: { width: 2000, level: 300 } },
        { key: 'brain', window: { width: 80, level: 40 } },
      ];
    case 'MRI':
      return [{ key: 'default', window: { width: 900, level: 450 } }];
    case 'ULTRASOUND':
      return [{ key: 'default', window: { width: 256, level: 128 } }];
    default:
      return [
        { key: 'default', window: { width: 1000, level: 500 } },
        { key: 'high-contrast', window: { width: 600, level: 450 } },
      ];
  }
}

function prng(seed: string) {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ell = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;

/** Synthetic value map (CT ≈ Hounsfield units; other modalities 0…1000) for one image. */
function valueAt(
  modality: string,
  variant: string,
  bodyPart: string,
  z: number,
  x: number,
  y: number,
  noise: number,
): number {
  if (modality === 'CT' || modality === 'MRI') {
    const mr = modality === 'MRI';
    // Tissue values: [air, fat, soft, fluid, lung, bone]
    const v = mr
      ? variant === 'T2'
        ? { air: 0, fat: 650, soft: 380, fluid: 900, lung: 30, bone: 60, grey: 520, white: 380 }
        : variant === 'FLAIR'
          ? { air: 0, fat: 500, soft: 420, fluid: 90, lung: 30, bone: 60, grey: 560, white: 420 }
          : { air: 0, fat: 850, soft: 450, fluid: 150, lung: 30, bone: 80, grey: 450, white: 620 }
      : { air: -1000, fat: -100, soft: 45, fluid: 5, lung: -850, bone: 900, grey: 40, white: 28 };
    if (isHead(bodyPart)) {
      const r = 0.95 - Math.abs(z - 0.45) * 0.9;
      const outer = ell(x, y, 256, 256, 190 * r + 20, 225 * r + 20);
      if (outer > 1) return v.air + noise * 4;
      const inner = ell(x, y, 256, 256, 172 * r + 18, 207 * r + 18);
      if (inner > 1) return v.bone + noise * 30;
      // Ventricles change shape through the stack.
      const vent =
        ell(x, y, 228, 240, 14 + 22 * (1 - Math.abs(z - 0.5) * 2), 48 * r) < 1 ||
        ell(x, y, 284, 240, 14 + 22 * (1 - Math.abs(z - 0.5) * 2), 48 * r) < 1;
      if (vent && z > 0.25 && z < 0.75) return v.fluid + noise * 3;
      const cortex = inner > 0.72;
      return (cortex ? v.grey : v.white) + noise * (mr ? 18 : 3);
    }
    const body = ell(x, y, 256, 262, 215, 160);
    if (body > 1) return y > 438 && y < 446 ? (mr ? 0 : 200) : v.air + noise * 4;
    if (body > 0.82) return v.fat + noise * 8;
    // Spine and spinal canal (posterior).
    if (ell(x, y, 256, 360, 30, 28) < 1) return ell(x, y, 256, 352, 10, 9) < 1 ? v.fluid : v.bone;
    // Aorta, anterior-left of the spine.
    if (ell(x, y, 278, 312, 15, 15) < 1) return mr ? v.fluid : 180 + noise * 6;
    const lungSize = Math.max(0, 1 - z * 1.6);
    if (lungSize > 0.05) {
      const l = ell(x, y, 170, 250, 82 * lungSize + 10, 108 * lungSize + 10);
      const r = ell(x, y, 342, 250, 82 * lungSize + 10, 108 * lungSize + 10);
      if (l < 1 || r < 1) {
        const vessel = Math.sin(x * 0.21 + z * 9) * Math.sin(y * 0.17 - z * 7) > 0.93;
        return vessel ? v.soft : v.lung + noise * 20;
      }
    }
    if (z > 0.15 && z < 0.5 && ell(x, y, 285, 255, 70, 58) < 1) return v.soft + 10 + noise * 5; // heart
    if (z > 0.38 && ell(x, y, 175, 270, 95, 82) < 1) return v.soft + 20 + noise * 5; // liver
    if (z > 0.45 && z < 0.8 && ell(x, y, 335, 255, 38, 30) < 1) return v.soft + 15 + noise * 5; // spleen
    if (z > 0.6 && (ell(x, y, 200, 330, 26, 34) < 1 || ell(x, y, 312, 330, 26, 34) < 1))
      return v.soft - 10 + noise * 5; // kidneys
    if (z > 0.55 && Math.sin(x * 0.08 + y * 0.05 + z * 20) > 0.75) return v.fluid + 5; // bowel
    return v.soft - 5 + noise * 6;
  }

  if (modality === 'ULTRASOUND') {
    const dx = x - 256;
    const dy = y - 20;
    const r = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dx, dy);
    if (r < 40 || r > 480 || Math.abs(angle) > 0.72) return 0;
    const depthLoss = 1 - r / 700;
    if (ell(x, y, 250 + z * 30, 280, 70, 46) < 1) return 12 + noise * 6; // hypoechoic structure
    if (Math.abs(ell(x, y, 256, 300, 210, 150) - 1) < 0.04) return 230 * depthLoss; // capsule
    return Math.max(0, (95 + noise * 70) * depthLoss);
  }

  if (modality === 'MAMMOGRAPHY') {
    const b = ell(x, y, 0, 256, variant === 'mlo' ? 330 : 300, 230);
    if (b > 1) return 20 + noise * 5;
    const texture = Math.sin(x * 0.05 + y * 0.09) * Math.cos(y * 0.04 - x * 0.02);
    return 380 + (1 - b) * 260 + texture * 80 + noise * 25;
  }

  // Projection radiography (and fluoroscopy frames).
  if (isHead(bodyPart)) {
    const outer = ell(x, y, 256, 250, 200, 225);
    if (outer > 1) return 30 + noise * 10;
    const inner = ell(x, y, 256, 250, 182, 207);
    if (inner > 1) return 900 + noise * 30;
    return 560 + noise * 25;
  }
  if (isLimb(bodyPart)) {
    const soft = Math.abs(x - 256) < 110;
    if (!soft) return 30 + noise * 10;
    const bone = Math.abs(x - 236) < 26 || Math.abs(x - 292) < 18;
    const joint = Math.abs(y - 256) < 6;
    if (bone && !joint) return (Math.abs(x - 236) < 14 ? 760 : 880) + noise * 25;
    return 420 + noise * 20;
  }
  const shift = variant === 'fluoro' ? Math.sin(z * Math.PI * 2) * 6 : 0;
  const body = ell(x, y, 256, 280, 235, 250);
  if (body > 1) return 25 + noise * 10;
  if (Math.abs(x - 256) < 20 && y > 60) return 820 + noise * 20; // spine
  // Ribs: curved bands across both hemithoraces.
  for (let k = 0; k < 9; k++) {
    const yc = 120 + k * 34 + 0.0016 * (x - 256) ** 2 + shift;
    if (Math.abs(y - yc) < 5 && Math.abs(x - 256) > 26 && Math.abs(x - 256) < 205) {
      return 700 + noise * 25;
    }
  }
  if (Math.abs(y - (95 + 0.0012 * (x - 256) ** 2)) < 6 && Math.abs(x - 256) < 190) return 720; // clavicles
  if (ell(x, y, 290, 340 + shift, 95, 85) < 1) return 600 + noise * 15; // heart shadow
  if (ell(x, y, 160, 270, 100, 175) < 1 || ell(x, y, 352, 270, 100, 175) < 1) {
    const vessel = Math.sin(x * 0.13) * Math.sin(y * 0.11) > 0.9;
    return (vessel ? 330 : 170) + noise * 25; // lungs
  }
  if (y > 430) return 520 + noise * 15; // diaphragm / abdomen
  return 460 + noise * 20;
}

/** Renders one synthetic image as a grayscale PNG with the given window. */
export function renderDemoImage(input: {
  studyUid: string;
  modality: string;
  bodyPart: string;
  seriesIndex: number;
  instanceIndex: number;
  instanceCount: number;
  seriesDescription: string;
  window: WindowSetting;
}): Buffer {
  const size = DEMO_SIZE;
  const variant = plan(input.modality, input.bodyPart)[input.seriesIndex]?.variant ?? 'default';
  const z = input.instanceCount > 1 ? input.instanceIndex / (input.instanceCount - 1) : 0.4;
  const rand = prng(`${input.studyUid}:${input.seriesIndex}:${input.instanceIndex}`);
  const lo = input.window.level - input.window.width / 2;
  const pixels = new Uint8Array(size * size);
  const lateral = variant === 'lat';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const noise = rand() * 2 - 1;
      // Lateral projections: squeeze horizontally to suggest a side view.
      const sx = lateral ? 256 + (x - 256) * 1.6 : x;
      const value = valueAt(input.modality, variant, input.bodyPart, z, sx, y, noise);
      const g = ((value - lo) / input.window.width) * 255;
      pixels[y * size + x] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    }
  }
  // Burned-in labels: make it impossible to mistake a demo image for a real one.
  const label = 'DEMO - SYNTHETIC IMAGE';
  for (let y = 6; y < 44; y++)
    for (let x = 6; x < 18 + textWidth(label); x++) pixels[y * size + x] = 0;
  drawText(pixels, size, label, 12, 10, 2, 255);
  drawText(pixels, size, 'NOT FOR DIAGNOSIS', 12, 28, 2, 200);
  const footer = `${input.seriesDescription.toUpperCase()}  IM ${input.instanceIndex + 1}/${input.instanceCount}`;
  for (let y = size - 30; y < size - 6; y++)
    for (let x = 6; x < 18 + textWidth(footer); x++) pixels[y * size + x] = 0;
  drawText(pixels, size, footer, 12, size - 24, 2, 230);
  return encodeGrayPng(size, size, pixels);
}
