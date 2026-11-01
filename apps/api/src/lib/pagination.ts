import { z } from 'zod';

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export function toOffset({ page, pageSize }: Pagination) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function paginated<T>(items: T[], total: number, { page, pageSize }: Pagination) {
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
