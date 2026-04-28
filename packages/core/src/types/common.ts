export type ISODate = string;
export type UUID = string;

export interface Paginated<T> {
  data: T[];
  total: number;
  cursor?: string | null;
  hasMore: boolean;
}

export interface PaginationInput {
  cursor?: string | null;
  limit?: number;
}

export type SortDirection = 'asc' | 'desc';

export interface SortInput<T extends string = string> {
  field: T;
  direction: SortDirection;
}
