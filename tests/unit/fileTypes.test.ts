import { describe, expect, it } from 'vitest';
import {
  classifyExtension,
  classifyFileName,
  fileTypeLabel,
  getExtension,
  isFileTypeKey,
} from '../../src/shared/fileTypes';

describe('fileTypes', () => {
  it('extracts the lowercase extension', () => {
    expect(getExtension('Movie.MP4')).toBe('mp4');
    expect(getExtension('archive.tar.gz')).toBe('gz');
    expect(getExtension('no-extension')).toBe('');
    expect(getExtension('.gitignore')).toBe('');
    expect(getExtension('trailing.')).toBe('');
    expect(getExtension('  spaced.JPG  ')).toBe('jpg');
  });

  it('classifies the nine categories', () => {
    expect(classifyFileName('a.mp4')).toBe('video');
    expect(classifyFileName('a.PNG')).toBe('image');
    expect(classifyFileName('a.docx')).toBe('document');
    expect(classifyFileName('a.flac')).toBe('audio');
    expect(classifyFileName('a.7z')).toBe('archive');
    expect(classifyFileName('a.msi')).toBe('installer');
    expect(classifyFileName('a.vhdx')).toBe('diskImage');
    expect(classifyFileName('a.dll')).toBe('program');
    expect(classifyFileName('a.unknownext')).toBe('other');
    expect(classifyFileName('README')).toBe('other');
  });

  it('classifies by extension directly', () => {
    expect(classifyExtension('JPG')).toBe('image');
    expect(classifyExtension('')).toBe('other');
  });

  it('labels every type in Chinese', () => {
    expect(fileTypeLabel('video')).toBe('视频');
    expect(fileTypeLabel('diskImage')).toBe('镜像');
    expect(fileTypeLabel('other')).toBe('其他');
  });

  it('validates type keys', () => {
    expect(isFileTypeKey('image')).toBe(true);
    expect(isFileTypeKey('Image')).toBe(false);
    expect(isFileTypeKey('unknown')).toBe(false);
  });
});
