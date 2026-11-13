import type { FileTypeKey } from './types';

export interface FileTypeMeta {
  key: FileTypeKey;
  label: string;
  color: string;
}

export const FILE_TYPES: readonly FileTypeMeta[] = [
  { key: 'video', label: '视频', color: '#1677ff' },
  { key: 'image', label: '图片', color: '#52c41a' },
  { key: 'document', label: '文档', color: '#faad14' },
  { key: 'audio', label: '音频', color: '#722ed1' },
  { key: 'archive', label: '压缩包', color: '#13c2c2' },
  { key: 'installer', label: '安装包', color: '#fa541c' },
  { key: 'diskImage', label: '镜像', color: '#2f54eb' },
  { key: 'program', label: '程序', color: '#8c8c8c' },
  { key: 'other', label: '其他', color: '#bfbfbf' },
];

export const FILE_TYPE_LABELS: Record<FileTypeKey, string> = {
  video: '视频',
  image: '图片',
  document: '文档',
  audio: '音频',
  archive: '压缩包',
  installer: '安装包',
  diskImage: '镜像',
  program: '程序',
  other: '其他',
};

const EXTENSION_TYPES: Record<string, FileTypeKey> = {
  mp4: 'video',
  mkv: 'video',
  avi: 'video',
  mov: 'video',
  wmv: 'video',
  flv: 'video',
  webm: 'video',
  m4v: 'video',
  mpg: 'video',
  mpeg: 'video',
  ts: 'video',
  rmvb: 'video',
  '3gp': 'video',

  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  heic: 'image',
  raw: 'image',
  tif: 'image',
  tiff: 'image',
  svg: 'image',
  ico: 'image',
  psd: 'image',

  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  pdf: 'document',
  txt: 'document',
  md: 'document',
  rtf: 'document',
  csv: 'document',
  odt: 'document',
  ods: 'document',
  odp: 'document',
  epub: 'document',

  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  wma: 'audio',
  ape: 'audio',

  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  tgz: 'archive',
  cab: 'archive',

  exe: 'installer',
  msi: 'installer',
  msix: 'installer',
  appx: 'installer',

  iso: 'diskImage',
  img: 'diskImage',
  vhd: 'diskImage',
  vhdx: 'diskImage',

  dll: 'program',
  sys: 'program',
  bin: 'program',
  dat: 'program',
  ocx: 'program',
  drv: 'program',
};

export function getExtension(fileName: string): string {
  const name = fileName.trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function classifyExtension(ext: string): FileTypeKey {
  return EXTENSION_TYPES[ext.toLowerCase()] ?? 'other';
}

export function classifyFileName(fileName: string): FileTypeKey {
  return classifyExtension(getExtension(fileName));
}

export function fileTypeLabel(type: FileTypeKey): string {
  return FILE_TYPE_LABELS[type] ?? '其他';
}

export function isFileTypeKey(value: string): value is FileTypeKey {
  return value in FILE_TYPE_LABELS;
}
