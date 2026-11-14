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
export const organizePrioritySchema = z.enum(['order', 'sameDrive']);
export type OrganizePriority = z.infer<typeof organizePrioritySchema>;
export const organizePreviewSchema = z
  .object({
    sourceDir: localOrganizePath,
    rules: organizeRulesSchema,
    priority: organizePrioritySchema,
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

export interface OrganizePreset {
  key: string;
  ruleName: string;
  description: string;
  type: FileTypeKey | 'all';
  extensions: string[];
  nameContains: string;
}

export const ORGANIZE_PRESETS: readonly OrganizePreset[] = [
  {
    key: 'video',
    ruleName: '视频归档',
    description: 'mp4、mkv、mov 等视频文件',
    type: 'video',
    extensions: [],
    nameContains: '',
  },
  {
    key: 'image',
    ruleName: '图片归档',
    description: 'jpg、png、heic 等图片文件',
    type: 'image',
    extensions: [],
    nameContains: '',
  },
  {
    key: 'document',
    ruleName: '文档归档',
    description: '文档、表格、演示文稿与 PDF',
    type: 'document',
    extensions: [],
    nameContains: '',
  },
  {
    key: 'audio',
    ruleName: '音乐归档',
    description: 'mp3、flac、wav 等音频文件',
    type: 'audio',
    extensions: [],
    nameContains: '',
  },
  {
    key: 'archive',
    ruleName: '压缩包归档',
    description: 'zip、rar、7z 等压缩文件',
    type: 'archive',
    extensions: [],
    nameContains: '',
  },
  {
    key: 'installer',
    ruleName: '安装包归档',
    description: 'exe、msi 等安装程序',
    type: 'installer',
    extensions: [],
    nameContains: '',
  },
];

export function createPresetRule(
  preset: OrganizePreset,
  id: string = crypto.randomUUID(),
): OrganizeRule {
  return {
    id,
    name: preset.ruleName,
    enabled: true,
    type: preset.type,
    extensions: [...preset.extensions],
    nameContains: preset.nameContains,
    targetDir: '',
  };
}

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
