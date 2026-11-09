/**
 * Code 39 barcode as SVG (specimen labels). Code 39 needs no check digit and encodes the order
 * numbers used here (A–Z, 0–9, dash); hand-held scanners read it as typed text. Each character is
 * nine elements – bar, space, bar … – of which three are wide (1 = wide).
 */
const PATTERNS: Record<string, string> = {
  '0': '000110100',
  '1': '100100001',
  '2': '001100001',
  '3': '101100000',
  '4': '000110001',
  '5': '100110000',
  '6': '001110000',
  '7': '000100101',
  '8': '100100100',
  '9': '001100100',
  A: '100001001',
  B: '001001001',
  C: '101001000',
  D: '000011001',
  E: '100011000',
  F: '001011000',
  G: '000001101',
  H: '100001100',
  I: '001001100',
  J: '000011100',
  K: '100000011',
  L: '001000011',
  M: '101000010',
  N: '000010011',
  O: '100010010',
  P: '001010010',
  Q: '000000111',
  R: '100000110',
  S: '001000110',
  T: '000010110',
  U: '110000001',
  V: '011000001',
  W: '111000000',
  X: '010010001',
  Y: '110010000',
  Z: '011010000',
  '-': '010000101',
  '.': '110000100',
  ' ': '011000100',
  '*': '010010100',
};

/** Bar rectangles (x, width) for a value; unknown characters are left out. */
export function code39Bars(value: string, narrow = 1, wide = 3) {
  const text = `*${value.toUpperCase().replace(/[^0-9A-Z. -]/g, '')}*`;
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of text) {
    const p = PATTERNS[ch]!;
    for (let i = 0; i < 9; i++) {
      const w = p[i] === '1' ? wide : narrow;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += narrow; // gap between characters
  }
  return { bars, width: x - narrow };
}

export function Code39({ value, height = 48 }: { value: string; height?: number }) {
  const { bars, width } = code39Bars(value);
  const quiet = 10;
  return (
    <svg
      className="code39"
      viewBox={`0 0 ${width + quiet * 2} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={value}
    >
      <rect x="0" y="0" width={width + quiet * 2} height={height} fill="#fff" />
      {bars.map((b, i) => (
        <rect key={i} x={b.x + quiet} y="0" width={b.w} height={height} fill="#000" />
      ))}
    </svg>
  );
}
