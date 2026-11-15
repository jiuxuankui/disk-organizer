import { z } from 'zod';
import { localOrganizePath, organizePrioritySchema, organizeRulesSchema } from '@shared/organize';
import { MAX_DUPLICATE_FOLDERS } from '@shared/constants';
import { FILE_TYPES } from '@shared/fileTypes';
import { THEME_IDS } from '@shared/themes';
import type { FileTypeKey } from '@shared/types';

const FILE_TYPE_KEYS = FILE_TYPES.map((item) => item.key) as [FileTypeKey, ...FileTypeKey[]];

export const driveLetterSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]:?$/, '硬盘格式应为 C:')
  .transform((value) => `${value.charAt(0).toUpperCase()}:`);

export const scanStartSchema = z
  .object({
    drives: z.array(driveLetterSchema).min(1, '请至少选择一块硬盘').max(26),
    excludedPaths: z.array(z.string().trim().min(1)).max(200).optional(),
    skipHiddenSystem: z.boolean().optional(),
  })
  .strict();

const videoPathSchema = z
  .string()
  .min(1)
  .max(32767)
  .refine((value) => !value.includes('\0'), '路径包含无效字符');

export const videoStartSchema = z
  .object({
    paths: z.array(videoPathSchema).min(1, '请至少选择一个视频').max(200),
    outputDir: videoPathSchema,
    quality: z.enum(['quality', 'balanced', 'smaller']),
  })
  .strict();

export const archiveStartSchema = z
  .object({
    fileIds: z.array(z.number().int().positive()).min(1).max(10000),
    outputDir: videoPathSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          !/[<>:"/\\|?*]/.test(value) &&
          ![...value].some((char) => char.charCodeAt(0) < 32) &&
          !/[. ]$/.test(value),
        '压缩包名称包含无效字符',
      )
      .refine(
        (value) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
        '不能使用系统保留名称',
      ),
    format: z.enum(['zip', 'tar.gz']),
  })
  .strict();

export const pathSchema = z.object({
  path: z.string().min(1, '路径不能为空').max(32767),
});

export const driveQuerySchema = z.object({
  drive: driveLetterSchema.nullish(),
});

export const folderQuerySchema = z
  .object({
    parentDir: localOrganizePath.nullish(),
    drive: driveLetterSchema.nullish(),
    search: z.string().max(512).optional(),
    minSize: z.number().int().nonnegative().nullish(),
    maxSize: z.number().int().nonnegative().nullish(),
    mtimeFrom: z.number().int().nonnegative().nullish(),
    mtimeTo: z.number().int().nonnegative().nullish(),
  })
  .strict();

export const fileQuerySchema = z
  .object({
    drive: driveLetterSchema.nullish(),
    type: z.enum([...FILE_TYPE_KEYS, 'all']).nullish(),
    minSize: z.number().int().nonnegative().nullish(),
    maxSize: z.number().int().nonnegative().nullish(),
    mtimeFrom: z.number().int().nonnegative().nullish(),
    mtimeTo: z.number().int().nonnegative().nullish(),
    rootDir: z.string().max(1024).nullish(),
    dirPath: z.string().max(32767).nullish(),
    dirPrefix: z.string().max(32767).nullish(),
    search: z.string().max(512).optional(),
    sortBy: z.enum(['size', 'mtime', 'name', 'type']).default('size'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    page: z.number().int().min(1).max(2_000_000).default(1),
    pageSize: z.number().int().min(1).max(1000).default(200),
  })
  .strict();

export const fileIdSchema = z
  .object({
    id: z.number().int().positive(),
  })
  .strict();

export const duplicatesStartSchema = z
  .object({
    drives: z.array(driveLetterSchema).min(1, '请至少选择一块硬盘').max(26).optional(),
    folders: z.array(localOrganizePath).min(1).max(MAX_DUPLICATE_FOLDERS).optional(),
    mode: z.enum(['full', 'name', 'hybrid']).default('full'),
  })
  .strict();

export const duplicateQuerySchema = z
  .object({
    minSize: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 ** 4)
      .default(0),
    drive: driveLetterSchema.nullish(),
    type: z.enum([...FILE_TYPE_KEYS, 'all']).nullish(),
    sortBy: z.enum(['reclaimable', 'size', 'count']).default('reclaimable'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
    page: z.number().int().min(1).max(2_000_000).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const copyTextSchema = z
  .object({
    text: z.string().min(1).max(32767),
  })
  .strict();

export const deleteFilesSchema = z
  .object({
    fileIds: z
      .array(z.number().int().positive())
      .max(200_000, '一次最多处理 200000 个文件')
      .default([]),
    folderPaths: z.array(localOrganizePath).max(1000, '一次最多处理 1000 个文件夹').default([]),
  })
  .strict()
  .refine((value) => value.fileIds.length + value.folderPaths.length > 0, '请至少选择一个项目');

export const longTrashIdSchema = z
  .object({
    id: z.string().uuid('记录编号无效'),
  })
  .strict();

export const settingsUpdateSchema = z
  .object({
    scanDrives: z.array(driveLetterSchema).max(26).optional(),
    excludedPaths: z.array(z.string().trim().min(1).max(1024)).max(200).optional(),
    skipHiddenSystem: z.boolean().optional(),
    minDuplicateSize: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 ** 4)
      .optional(),
    autoBackup: z.boolean().optional(),
    organizeRules: organizeRulesSchema.optional(),
    organizePriority: organizePrioritySchema.optional(),
    theme: z.enum(THEME_IDS).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '没有需要保存的设置');

export type DeleteFilesPayload = z.infer<typeof deleteFilesSchema>;
export type SettingsUpdatePayload = z.infer<typeof settingsUpdateSchema>;
export type DuplicatesStartPayload = z.infer<typeof duplicatesStartSchema>;
export type DuplicateQueryPayload = z.infer<typeof duplicateQuerySchema>;

export type ScanStartPayload = z.infer<typeof scanStartSchema>;
export type FileQueryPayload = z.infer<typeof fileQuerySchema>;

export function parseIpc<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  label: string,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${label}参数无效：${issue?.message ?? '格式错误'}`);
  }
  return result.data;
}
