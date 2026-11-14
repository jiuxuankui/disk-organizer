import { describe, expect, it } from 'vitest';
import { FILE_TYPES } from '@shared/fileTypes';
import { createPresetRule, ORGANIZE_PRESETS, organizeRulesSchema } from '@shared/organize';

const PRESET_ID = '11111111-1111-4111-8111-111111111111';

describe('归类整理预设规则', () => {
  it('提供视频、图片、文档、音乐、压缩包和安装包预设', () => {
    expect(ORGANIZE_PRESETS.map((preset) => preset.key)).toEqual([
      'video',
      'image',
      'document',
      'audio',
      'archive',
      'installer',
    ]);
    const typeKeys = new Set<string>(FILE_TYPES.map((type) => type.key));
    for (const preset of ORGANIZE_PRESETS) {
      expect(preset.type).not.toBe('all');
      expect(typeKeys.has(preset.type)).toBe(true);
      expect(preset.ruleName.endsWith('归档')).toBe(true);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('预设名称与类型一一对应', () => {
    expect(new Set(ORGANIZE_PRESETS.map((preset) => preset.ruleName)).size).toBe(
      ORGANIZE_PRESETS.length,
    );
    expect(new Set(ORGANIZE_PRESETS.map((preset) => preset.type)).size).toBe(
      ORGANIZE_PRESETS.length,
    );
  });

  it('一键生成的规则可编辑并通过保存校验', () => {
    const rule = createPresetRule(ORGANIZE_PRESETS[0], PRESET_ID);
    expect(rule).toEqual({
      id: PRESET_ID,
      name: '视频归档',
      enabled: true,
      type: 'video',
      extensions: [],
      nameContains: '',
      targetDir: '',
      minSize: null,
      maxSize: null,
      mtimeFrom: null,
      mtimeTo: null,
      pathContains: '',
      matchMode: 'all',
    });

    const [parsed] = organizeRulesSchema.parse([{ ...rule, targetDir: 'D:\\归档\\视频' }]);
    expect(parsed.name).toBe('视频归档');
    expect(parsed.type).toBe('video');
  });
});
