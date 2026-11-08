import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';

/**
 * Small-cell suppression for public tables.
 *
 * Primary: a count from 1 to SMALL_CELL_THRESHOLD − 1 is never published (zero is published – it
 * reveals nobody). Secondary: when the cells of a group add up to a published total (e.g. the
 * municipalities of a cohort and the national row), a single hidden cell could be worked out by
 * subtraction. Then the smallest other non-zero cell of the group is hidden too; if there is no
 * such cell, the total is hidden instead. Two hidden cells cannot be told apart from the total.
 * Values derived from a hidden count (percentages, medians) are hidden with it.
 */
export const THRESHOLD = SMALL_CELL_THRESHOLD;

export const isSmall = (n: number) => n > 0 && n < THRESHOLD;

/** Which cells (and the total) of a group to hide. */
export function suppressGroup(
  cells: number[],
  total?: number,
): { hidden: boolean[]; totalHidden: boolean } {
  const hidden = cells.map(isSmall);
  let totalHidden = total !== undefined && isSmall(total);
  if (total !== undefined && !totalHidden && hidden.filter(Boolean).length === 1) {
    let candidate = -1;
    cells.forEach((n, i) => {
      if (hidden[i] || n <= 0) return;
      if (candidate === -1 || n < cells[candidate]!) candidate = i;
    });
    if (candidate >= 0) hidden[candidate] = true;
    else totalHidden = true;
  }
  return { hidden, totalHidden };
}

export const pct = (num: number | null, den: number | null) =>
  num === null || den === null || den === 0 ? null : Math.round((num / den) * 1000) / 10;
