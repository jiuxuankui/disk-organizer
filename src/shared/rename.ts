import { z } from 'zod';
import { localOrganizePath } from './organize';

export const RENAME_ITEM_LIMIT = 20000;
export const RENAME_RULE_LIMIT = 30;

const ruleBase = {
  id: z.string().uuid(),
  enabled: z.boolean(),
};

export const renameRuleSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...ruleBase,
      type: z.literal('findReplace'),
      find: z.string().max(512),
      replace: z.string().max(512),
      useRegex: z.boolean(),
      caseSensitive: z.boolean(),
      replaceAll: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('prefixSuffix'),
      prefix: z.string().max(120),
      suffix: z.string().max(120),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('deleteRange'),
      start: z.number().int().min(1).max(32767),
      count: z.number().int().min(1).max(32767),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('insertAt'),
      position: z.number().int().min(1).max(32768),
      text: z.string().max(120),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('numbering'),
      start: z.number().int().min(0).max(999_999_999),
      step: z.number().int().min(1).max(1_000_000),
      padding: z.number().int().min(0).max(12),
      position: z.enum(['prefix', 'suffix', 'replace']),
      separator: z.string().max(20),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('case'),
      mode: z.enum(['upper', 'lower', 'capitalize', 'title']),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('extension'),
      extension: z
        .string()
        .max(30)
        .refine((value) => !/[<>:"/\\|?*\s]/.test(value), '扩展名包含无效字符')
        .refine((value) => !value.replace(/^\.+/, '').endsWith('.'), '扩展名不能以点结尾'),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('date'),
      source: z.enum(['mtime', 'now']),
      format: z.enum([
        'YYYYMMDD',
        'YYYY-MM-DD',
        'YYYYMMDD_HHmmss',
        'YYYY-MM-DD_HHmmss',
        'YYYY年MM月DD日',
        'YYYY年MM月DD日_HHmmss',
      ]),
      position: z.enum(['prefix', 'suffix']),
    })
    .strict(),
  z
    .object({
      ...ruleBase,
      type: z.literal('deleteMarker'),
      marker: z.string().max(120),
      direction: z.enum(['before', 'after']),
      includeMarker: z.boolean(),
      occurrence: z.enum(['first', 'last']),
      caseSensitive: z.boolean(),
    })
    .strict(),
]);

export const renameRulesSchema = z
  .array(renameRuleSchema)
  .max(RENAME_RULE_LIMIT, `最多 ${RENAME_RULE_LIMIT} 条重命名规则`)
  .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, '规则编号不能重复');

export const renameItemSchema = z
  .object({
    fileId: z.number().int().positive().nullable().default(null),
    path: localOrganizePath,
    kind: z.enum(['file', 'folder']),
  })
  .strict();

export const renamePreviewSchema = z
  .object({
    items: z
      .array(renameItemSchema)
      .min(1, '请添加要重命名的文件或文件夹')
      .max(RENAME_ITEM_LIMIT, `一次最多重命名 ${RENAME_ITEM_LIMIT} 个项目`),
    rules: renameRulesSchema,
  })
  .strict();

export const renameStartSchema = z.object({ token: z.string().uuid() }).strict();

export const renamePickSchema = z.object({ kind: z.enum(['file', 'folder']) }).strict();

export const renameInspectSchema = z
  .object({
    paths: z
      .array(z.string().min(1).max(32767))
      .min(1, '没有可添加的项目')
      .max(RENAME_ITEM_LIMIT, `一次最多添加 ${RENAME_ITEM_LIMIT} 个项目`),
  })
  .strict();

export type RenameRule = z.infer<typeof renameRuleSchema>;
export type RenameRuleType = RenameRule['type'];
export type RenameItem = z.infer<typeof renameItemSchema>;
export type RenamePreviewRequest = z.infer<typeof renamePreviewSchema>;
export type RenameStartRequest = z.infer<typeof renameStartSchema>;
export type RenamePickKind = z.infer<typeof renamePickSchema>['kind'];
export type RenameInspectRequest = z.infer<typeof renameInspectSchema>;

export const RENAME_RULE_LABELS: Record<RenameRuleType, string> = {
  findReplace: '查找替换',
  prefixSuffix: '添加前缀/后缀',
  deleteRange: '按位置删除',
  insertAt: '按位置插入',
  numbering: '添加序号',
  case: '大小写转换',
  extension: '修改扩展名',
  date: '插入日期',
  deleteMarker: '删除标记前/后',
};

export const RENAME_RULE_NOTES: Record<RenameRuleType, string> = {
  findReplace: '可选用正则表达式；不区分大小写时按文本安全替换，可只替换第一处或全部替换。',
  prefixSuffix: '在名称前后添加固定文字；文件只处理扩展名之前的部分。',
  deleteRange: '从第 1 个字开始计数，删除指定数量的字符。',
  insertAt: '在第 N 个字之前插入文字；N 等于名称长度加 1 时插到末尾。',
  numbering: '按当前列表顺序编号，可设置起始值、步长、位数和分隔符。',
  case: '全部大写、全部小写、首字母大写或每个词首字母大写。',
  extension: '只对文件生效，不改变文件内容；留空表示去掉扩展名。',
  date: '插入文件修改日期或当前日期；格式固定，避免文件名出现非法字符。',
  deleteMarker: '标记可以是任意文字、数字或符号；未找到标记时保留原名并提示。',
};

function ruleId(): string {
  return crypto.randomUUID();
}

export function createRenameRule(type: RenameRuleType): RenameRule {
  switch (type) {
    case 'findReplace':
      return {
        id: ruleId(),
        enabled: true,
        type,
        find: '',
        replace: '',
        useRegex: false,
        caseSensitive: false,
        replaceAll: true,
      };
    case 'prefixSuffix':
      return { id: ruleId(), enabled: true, type, prefix: '', suffix: '' };
    case 'deleteRange':
      return { id: ruleId(), enabled: true, type, start: 1, count: 1 };
    case 'insertAt':
      return { id: ruleId(), enabled: true, type, position: 1, text: '' };
    case 'numbering':
      return {
        id: ruleId(),
        enabled: true,
        type,
        start: 1,
        step: 1,
        padding: 3,
        position: 'suffix',
        separator: '_',
      };
    case 'case':
      return { id: ruleId(), enabled: true, type, mode: 'lower' };
    case 'extension':
      return { id: ruleId(), enabled: true, type, extension: '' };
    case 'date':
      return {
        id: ruleId(),
        enabled: true,
        type,
        source: 'mtime',
        format: 'YYYY-MM-DD',
        position: 'prefix',
      };
    case 'deleteMarker':
      return {
        id: ruleId(),
        enabled: true,
        type,
        marker: '',
        direction: 'before',
        includeMarker: false,
        occurrence: 'first',
        caseSensitive: false,
      };
  }
}

export interface RenameRuleContext {
  index: number;
  now: number;
  mtimeMs: number;
}

export interface RenameRuleResult {
  name: string;
  notes: string[];
}

function splitName(
  name: string,
  kind: 'file' | 'folder',
): { stem: string; extension: string } {
  if (kind === 'folder') return { stem: name, extension: '' };
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function replaceText(
  input: string,
  find: string,
  replace: string,
  replaceAll: boolean,
  caseSensitive: boolean,
): string {
  if (!find) return input;
  const haystack = caseSensitive ? input : input.toLowerCase();
  const needle = caseSensitive ? find : find.toLowerCase();
  if (replaceAll) {
    let result = '';
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) {
        result += input.slice(from);
        return result;
      }
      result += input.slice(from, index) + replace;
      from = index + find.length;
      if (from >= input.length) return result;
    }
  }
  const index = haystack.indexOf(needle);
  if (index < 0) return input;
  return input.slice(0, index) + replace + input.slice(index + find.length);
}

function applyCase(input: string, mode: 'upper' | 'lower' | 'capitalize' | 'title'): string {
  switch (mode) {
    case 'upper':
      return input.toUpperCase();
    case 'lower':
      return input.toLowerCase();
    case 'capitalize':
      return input.length === 0 ? input : input.charAt(0).toUpperCase() + input.slice(1);
    case 'title':
      return input.replace(/(^|[\s\-_])(\p{L})/gu, (_match, lead: string, letter: string) => {
        return lead + letter.toUpperCase();
      });
    default:
      return input;
  }
}

function padNumber(value: number, padding: number): string {
  const text = String(value);
  if (padding <= text.length) return text;
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  return `${negative ? '-' : ''}${digits.padStart(padding, '0')}`;
}

function formatDate(timestamp: number, format: string): string {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  switch (format) {
    case 'YYYYMMDD':
      return `${year}${month}${day}`;
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'YYYYMMDD_HHmmss':
      return `${year}${month}${day}_${hour}${minute}${second}`;
    case 'YYYY-MM-DD_HHmmss':
      return `${year}-${month}-${day}_${hour}${minute}${second}`;
    case 'YYYY年MM月DD日':
      return `${year}年${month}月${day}日`;
    case 'YYYY年MM月DD日_HHmmss':
      return `${year}年${month}月${day}日_${hour}${minute}${second}`;
    default:
      return `${year}-${month}-${day}`;
  }
}

export function applyRenameRules(
  originalName: string,
  kind: 'file' | 'folder',
  rules: RenameRule[],
  context: RenameRuleContext,
): RenameRuleResult {
  const split = splitName(originalName, kind);
  let stem = split.stem;
  let extension = split.extension;
  const notes: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    switch (rule.type) {
      case 'findReplace': {
        if (!rule.find) break;
        if (rule.useRegex) {
          let expression: RegExp;
          try {
            const flags = `${rule.replaceAll ? 'g' : ''}${rule.caseSensitive ? '' : 'i'}`;
            expression = new RegExp(rule.find, flags);
          } catch (error) {
            throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`);
          }
          stem = stem.replace(expression, rule.replace);
        } else {
          stem = replaceText(stem, rule.find, rule.replace, rule.replaceAll, rule.caseSensitive);
        }
        break;
      }
      case 'prefixSuffix':
        stem = `${rule.prefix}${stem}${rule.suffix}`;
        break;
      case 'deleteRange': {
        const start = rule.start - 1;
        if (start >= stem.length) break;
        stem = stem.slice(0, start) + stem.slice(start + rule.count);
        break;
      }
      case 'insertAt': {
        const position = Math.min(rule.position - 1, stem.length);
        stem = stem.slice(0, position) + rule.text + stem.slice(position);
        break;
      }
      case 'numbering': {
        const number = padNumber(
          (context.index - 1) * rule.step + rule.start,
          rule.padding,
        );
        if (rule.position === 'replace') stem = number;
        else if (rule.position === 'prefix') stem = number + rule.separator + stem;
        else stem = stem + rule.separator + number;
        break;
      }
      case 'case':
        stem = applyCase(stem, rule.mode);
        break;
      case 'extension': {
        if (kind !== 'file') break;
        const next = rule.extension.trim().replace(/^\.+/, '');
        extension = next ? `.${next}` : '';
        break;
      }
      case 'date': {
        const text = formatDate(
          rule.source === 'mtime' ? context.mtimeMs : context.now,
          rule.format,
        );
        stem = rule.position === 'prefix' ? text + stem : stem + text;
        break;
      }
      case 'deleteMarker': {
        if (!rule.marker) {
          notes.push('标记为空，未处理');
          break;
        }
        const haystack = rule.caseSensitive ? stem : stem.toLowerCase();
        const needle = rule.caseSensitive ? rule.marker : rule.marker.toLowerCase();
        const index =
          rule.occurrence === 'first' ? haystack.indexOf(needle) : haystack.lastIndexOf(needle);
        if (index < 0) {
          notes.push('未找到标记');
          break;
        }
        if (rule.direction === 'before') {
          const start = rule.includeMarker ? index + rule.marker.length : index;
          stem = stem.slice(start);
        } else {
          const end = rule.includeMarker ? index : index + rule.marker.length;
          stem = stem.slice(0, end);
        }
        break;
      }
    }
  }

  return { name: stem + extension, notes };
}

export function validateRenameName(name: string): string | null {
  if (!name) return '新名称为空';
  if (name.length > 255) return '新名称超过 255 个字符';
  if (/[<>:"/\\|?*]/.test(name)) return '新名称包含 Windows 不允许的字符';
  if ([...name].some((char) => char.charCodeAt(0) < 32)) return '新名称包含控制字符';
  if (/[. ]$/.test(name)) return '新名称不能以空格或点结尾';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return '新名称是系统保留名称';
  if (name === '.' || name === '..') return '新名称不能是 . 或 ..';
  return null;
}

export type RenameItemStatus = 'ready' | 'unchanged' | 'skipped' | 'blocked';

export interface RenamePreviewItem {
  path: string;
  kind: 'file' | 'folder';
  name: string;
  newName: string;
  target: string;
  size: number;
  status: RenameItemStatus;
  message: string;
  notes: string[];
}

export interface RenamePreview {
  token: string;
  items: RenamePreviewItem[];
  readyCount: number;
  unchangedCount: number;
  skippedCount: number;
  blockedCount: number;
}

export type RenameResultStatus = 'renamed' | 'restored' | 'failed' | 'cancelled';

export interface RenameResult {
  source: string;
  target: string;
  kind: 'file' | 'folder';
  status: RenameResultStatus;
  message: string;
}

export interface RenameState {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'cancelled';
  mode: 'rename' | 'undo' | null;
  total: number;
  processed: number;
  currentPath: string;
  results: RenameResult[];
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RenameUndoInfo {
  count: number;
  createdAt: number;
}

export const RENAME_CASE_OPTIONS = [
  { value: 'upper', label: '全部大写' },
  { value: 'lower', label: '全部小写' },
  { value: 'capitalize', label: '首字母大写' },
  { value: 'title', label: '每个词首字母大写' },
] as const;

export const RENAME_DATE_FORMATS = [
  { value: 'YYYYMMDD', label: '20240131' },
  { value: 'YYYY-MM-DD', label: '2024-01-31' },
  { value: 'YYYYMMDD_HHmmss', label: '20240131_235959' },
  { value: 'YYYY-MM-DD_HHmmss', label: '2024-01-31_235959' },
  { value: 'YYYY年MM月DD日', label: '2024年01月31日' },
  { value: 'YYYY年MM月DD日_HHmmss', label: '2024年01月31日_235959' },
] as const;
