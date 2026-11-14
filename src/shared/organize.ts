import { z } from 'zod';
import { FILE_TYPES } from './fileTypes';
import type { FileTypeKey } from './types';

export const localOrganizePath = z
  .string()
  .min(3)
  .max(32767)
  .refine(
    (value) => /^[a-z]:[\\/]/i.test(value) && !/[:\0]/.test(value.slice(2)),
    '只支持本地硬盘绝对路径',
  );

export const organizeRuleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    type: z.enum(['all', ...FILE_TYPES.map((item) => item.key)] as ['all', ...FileTypeKey[]]),
    extensions: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\.?[a-z0-9_-]{1,30}$/i)
          .transform((value) => value.replace(/^\./, '').toLowerCase()),
      )
      .max(50),
    nameContains: z.string().trim().max(120),
    targetDir: localOrganizePath,
  })
  .strict();
export const organizeRulesSchema = z
  .array(organizeRuleSchema)
  .max(50)
  .refine(
    (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
    '规则编号不能重复',
  );
export const organizePreviewSchema = z
  .object({
    sourceDir: localOrganizePath,
    rules: organizeRulesSchema,
  })
  .strict();
export const organizeStartSchema = z
  .object({
    token: z.string().uuid(),
    fileIds: z.array(z.number().int().positive()).min(1).max(10000),
    confirmCrossDrive: z.boolean(),
  })
  .strict();
export type OrganizeRule = z.infer<typeof organizeRuleSchema>;
export type OrganizePreviewRequest = z.infer<typeof organizePreviewSchema>;
export type OrganizeStartRequest = z.infer<typeof organizeStartSchema>;
export interface OrganizeItem {
  id: number;
  source: string;
  target: string;
  size: number;
  rule: string;
  crossDrive: boolean;
  message: string;
  allowed: boolean;
}
export interface OrganizePreview {
  token: string;
  items: OrganizeItem[];
}
export interface OrganizeResult {
  source: string;
  target: string;
  status: 'moved' | 'failed' | 'cancelled';
  message: string;
}
export interface OrganizeState {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled';
  total: number;
  processed: number;
  currentPath: string;
  results: OrganizeResult[];
}
