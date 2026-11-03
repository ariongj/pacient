import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { t } from '../i18n';

/* -------------------------------------------------------------------------------- types */

export interface CatalogItem {
  id: string;
  name: string;
  atcCode: string | null;
  form: string;
  strength: string | null;
  unit: string;
  isEssential: boolean;
  isActive: boolean;
}

export type StockStatus = 'OK' | 'LOW' | 'OUT' | 'EXPIRING' | 'EXPIRED';

export interface StockLevel {
  itemId: string;
  name: string;
  atcCode: string | null;
  form: string;
  strength: string | null;
  unit: string;
  isEssential: boolean;
  onHand: number;
  expiredQuantity: number;
  expiringQuantity: number;
  reorderLevel: number;
  nextExpiry: string | null;
  status: StockStatus;
  flags: StockStatus[];
}

export interface StockBatch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  supplier: string | null;
  receivedAt: string;
  expired: boolean;
}

export interface StockMovement {
  id: string;
  type: MovementType;
  quantity: number;
  reason: string | null;
  prescriptionId: string | null;
  createdAt: string;
  itemId: string;
  itemName: string;
  itemStrength: string | null;
  itemForm: string;
  unit: string;
  batchNumber: string | null;
  byName: string;
}

export type MovementType =
  | 'RECEIPT'
  | 'DISPENSE'
  | 'ADJUSTMENT'
  | 'EXPIRED'
  | 'DAMAGED'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'RETURN';

export interface NationalItem {
  itemId: string;
  name: string;
  strength: string | null;
  form: string;
  unit: string;
  atcCode: string | null;
  isEssential: boolean;
  totalUnits: number;
  ok: number;
  low: number;
  out: number;
  outFacilities: string[];
  lowFacilities: string[];
}

export interface DispenseStockInfo {
  item: CatalogItem | null;
  candidates: Pick<CatalogItem, 'id' | 'name' | 'form' | 'strength' | 'unit' | 'atcCode'>[];
  batches: StockBatch[];
  level: StockLevel | null;
  suggestedUnits: number | null;
  suggestion: { lines: { batchId: string; units: number }[]; shortBy: number } | null;
}

/* ------------------------------------------------------------------------------- labels */

export const itemName = (i: { name: string; strength: string | null; form: string }) =>
  [i.name, i.strength, i.form].filter(Boolean).join(' ');

export const STATUS_TONE: Record<StockStatus, 'success' | 'warning' | 'danger' | 'info'> = {
  OK: 'success',
  LOW: 'warning',
  OUT: 'danger',
  EXPIRING: 'info',
  EXPIRED: 'danger',
};

export function statusLabel(s: StockStatus): string {
  switch (s) {
    case 'OK':
      return t('In stock');
    case 'LOW':
      return t('Low stock');
    case 'OUT':
      return t('Out of stock');
    case 'EXPIRING':
      return t('Expiring soon');
    case 'EXPIRED':
      return t('Expired stock');
  }
}

export function movementLabel(m: MovementType): string {
  const labels: Record<MovementType, string> = {
    RECEIPT: t('Delivery received'),
    DISPENSE: t('Dispensed'),
    ADJUSTMENT: t('Stock count correction'),
    EXPIRED: t('Written off – expired'),
    DAMAGED: t('Written off – damaged'),
    TRANSFER_OUT: t('Transferred out'),
    TRANSFER_IN: t('Transferred in'),
    RETURN: t('Returned to stock'),
  };
  return labels[m];
}

/* -------------------------------------------------------------------------------- hooks */

export const STOCK_KEY = ['stock'] as const;

export function useCatalogSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'catalog', q],
    queryFn: () =>
      api<{ items: CatalogItem[] }>('/stock/catalog', { query: { q } }).then((r) => r.items),
    enabled: enabled && q.trim().length >= 2,
    staleTime: 60_000,
  });
}

export function useStockLevels(filters: { q?: string; status?: string; all?: boolean }) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'levels', filters],
    queryFn: () =>
      api<{
        items: StockLevel[];
        counts: Record<string, number>;
        total: number;
        canEdit: boolean;
      }>('/stock/levels', {
        query: {
          q: filters.q || undefined,
          status: filters.status ?? 'ALL',
          all: filters.all ? 'true' : undefined,
        },
      }),
  });
}

export function useItemBatches(itemId: string | null) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'batches', itemId],
    queryFn: () =>
      api<{ item: CatalogItem; level: StockLevel | null; batches: StockBatch[] }>(
        `/stock/items/${itemId}/batches`,
      ),
    enabled: Boolean(itemId),
  });
}

export function useMovements(filters: { itemId?: string; type?: string; page: number }) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'movements', filters],
    queryFn: () =>
      api<{ items: StockMovement[]; page: number; totalPages: number; total: number }>(
        '/stock/movements',
        {
          query: {
            itemId: filters.itemId || undefined,
            type: filters.type || undefined,
            page: filters.page,
          },
        },
      ),
  });
}

export function useNationalStock(essential: boolean) {
  return useQuery({
    queryKey: [...STOCK_KEY, 'national', essential],
    queryFn: () =>
      api<{
        items: NationalItem[];
        summary: { items: number; withShortage: number; withLowStock: number };
      }>('/stock/national', { query: { essential: String(essential) } }),
  });
}

/** Mutations on stock refresh every stock view (and the pharmacy queue). */
export function useStockMutation<TBody>(path: string, method: 'POST' | 'PUT' = 'POST') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody & { pathSuffix?: string }) => {
      const { pathSuffix, ...rest } = body as TBody & { pathSuffix?: string };
      return api(`${path}${pathSuffix ?? ''}`, { method, body: rest });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STOCK_KEY });
      void qc.invalidateQueries({ queryKey: ['pharmacy'] });
    },
  });
}
