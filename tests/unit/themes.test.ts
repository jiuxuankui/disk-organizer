import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_IDS,
  getTheme,
  isThemeId,
  themeCssVariables,
} from '../../src/shared/themes';

const REQUIRED_VARIABLES = [
  '--app-bg',
  '--sidebar-bg',
  '--surface-bg',
  '--text-primary',
  '--text-secondary',
  '--border-color',
  '--accent',
  '--accent-soft',
  '--card-radius',
  '--font-family',
  '--table-header-bg',
  '--shadow-soft',
];

describe('theme registry', () => {
  it('ships the default theme plus nine new skins with unique ids', () => {
    expect(THEMES).toHaveLength(10);
    expect(THEME_IDS).toHaveLength(10);
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    expect(THEMES.filter((skin) => skin.id !== DEFAULT_THEME)).toHaveLength(9);
    expect(getTheme(DEFAULT_THEME).id).toBe(DEFAULT_THEME);
  });

  it('describes every skin and defines complete visual variables', () => {
    for (const skin of THEMES) {
      expect(skin.name.trim().length).toBeGreaterThan(0);
      expect(skin.description.trim().length).toBeGreaterThan(0);
      expect(skin.radius.card).toBeGreaterThan(0);
      expect(skin.radius.control).toBeGreaterThan(0);
      expect(skin.fontFamily).toContain('sans-serif');
      expect(skin.shadow.soft.length).toBeGreaterThan(0);
      expect(skin.shadow.medium.length).toBeGreaterThan(0);
      expect(skin.palette.accent).not.toBe(skin.palette.surfaceBg);

      const variables = themeCssVariables(skin);
      for (const name of REQUIRED_VARIABLES) {
        expect(variables[name], `${skin.id} ${name}`).toBeTruthy();
      }
    }
  });

  it('falls back to the classic theme for unknown ids', () => {
    expect(getTheme('unknown').id).toBe(DEFAULT_THEME);
    expect(getTheme(null).id).toBe(DEFAULT_THEME);
    expect(isThemeId('midnight')).toBe(true);
    expect(isThemeId('midnight-2')).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });
});
