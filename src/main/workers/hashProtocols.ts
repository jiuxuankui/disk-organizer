import type { HashWorkItem, HashWorkResult } from '../services/hashRunner';

export type HashWorkerInbound = { type: 'hash'; item: HashWorkItem };

export type HashWorkerOutbound =
  | { type: 'done'; id: number; result: Omit<HashWorkResult, 'id'> }
  | { type: 'failed'; id: number; message: string };
