import { Events } from 'obsidian';
import {
  DEFAULT_REDNOTE_SETTINGS,
  REDNOTE_FONT_OPTIONS,
  RedNoteAssetField,
  RedNoteFontOption,
  RedNoteSettings,
  clampRedNoteFontSize,
} from './types';
import {
  DEFAULT_REDNOTE_TEMPLATE_ID,
  getRedNoteTemplatePreset,
  isVisibleRedNoteTemplate,
  REDNOTE_TEMPLATE_PRESETS,
} from './template-presets';

export interface RedNotePluginData {
  importedFromMDFlow?: boolean;
  wechatThemeId?: string;
  rednote?: Partial<RedNoteSettings>;
}

export type RedNoteData = RedNotePluginData;

export interface RedNoteSettingsHost {
  load(): Promise<unknown>;
  save(data: RedNotePluginData): Promise<void>;
  reportError?(message: string): void;
}

export class RedNoteSettingsManager extends Events {
  private settings: RedNoteSettings = DEFAULT_REDNOTE_SETTINGS;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private host: RedNoteSettingsHost) {
    super();
  }

  async load(): Promise<void> {
    const rawData = await this.host.load();
    const pluginData = this.normalizePluginData(rawData);
    this.settings = this.normalizeSettings(pluginData.rednote);
  }

  importLegacy(raw: unknown): Promise<boolean> {
    return this.enqueue(() => this.importLegacySerial(raw));
  }

  private async importLegacySerial(raw: unknown): Promise<boolean> {
    const current = this.normalizePluginData(await this.host.load());
    if (current.importedFromMDFlow) return false;
    const legacy = this.normalizePluginData(raw);
    if (!legacy.rednote) throw new Error('未找到可导入的 MDFlow 排版设置');
    const next = this.normalizeSettings(legacy.rednote);
    await this.host.save({ ...current, rednote: next, importedFromMDFlow: true });
    this.settings = next;
    this.trigger('change', this.settings);
    return true;
  }

  getSettings(): RedNoteSettings {
    return this.settings;
  }

  getTemplate(id?: string) {
    return getRedNoteTemplatePreset(id || this.settings.templateId);
  }

  getTemplates() {
    return Object.values(REDNOTE_TEMPLATE_PRESETS).filter(template => isVisibleRedNoteTemplate(template.id));
  }

  getFontOptions(): RedNoteFontOption[] {
    const byValue = new Map<string, RedNoteFontOption>();

    [...REDNOTE_FONT_OPTIONS, ...this.settings.customFonts].forEach((font) => {
      byValue.set(font.value, font);
    });

    return Array.from(byValue.values());
  }

  update(patch: Partial<RedNoteSettings>): Promise<void> {
    return this.enqueue(() => this.updateSerial(patch));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation, operation);
    this.writes = pending.catch(() => undefined);
    return pending;
  }

  private async updateSerial(patch: Partial<RedNoteSettings>): Promise<void> {
    const previous = this.settings;
    this.settings = this.normalizeSettings({
      ...this.settings,
      ...patch,
    });

    try {
      await this.save();
    } catch (error) {
      this.settings = previous;
      throw error;
    }
    this.trigger('change', this.settings);
  }

  async resetAsset(field: RedNoteAssetField): Promise<void> {
    await this.update({ [field]: '' });
  }

  private async save(): Promise<void> {
    const rawData = await this.host.load();
    const pluginData = this.normalizePluginData(rawData);
    await this.host.save({ ...pluginData, rednote: this.settings });
  }

  private normalizePluginData(rawData: unknown): RedNotePluginData {
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      if (rawData !== null && rawData !== undefined) this.host.reportError?.('排版设置结构损坏，已使用默认值；原始数据未自动覆盖，可在设置中重新保存恢复。');
      return {};
    }

    const maybeData = rawData as RedNotePluginData & Partial<RedNoteSettings>;
    if (maybeData.rednote && typeof maybeData.rednote === 'object') {
      return maybeData;
    }

    if ('templateId' in maybeData || 'userName' in maybeData || 'footerLeftText' in maybeData) {
      return { rednote: maybeData };
    }

    return maybeData;
  }

  private normalizeSettings(input?: Partial<RedNoteSettings>): RedNoteSettings {
    const clean: Record<string, unknown> = {};
    let invalid = false;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const [key, value] of Object.entries(input)) {
        if (!(key in DEFAULT_REDNOTE_SETTINGS)) continue;
        if (key === 'customFonts') {
          if (Array.isArray(value)) {
            clean.customFonts = value.filter((font) => {
              const valid = font && typeof font.label === 'string' && typeof font.value === 'string' && font.value.trim();
              if (!valid) invalid = true;
              return valid;
            }).map((font) => ({
              label: font.label,
              value: font.value,
              isPreset: font.isPreset === true,
            }));
          } else invalid = true;
        } else if (typeof value === typeof DEFAULT_REDNOTE_SETTINGS[key as keyof RedNoteSettings] && (typeof value !== 'number' || Number.isFinite(value))) {
          clean[key] = value;
        } else invalid = true;
      }
    } else if (input !== undefined) invalid = true;
    if (invalid) this.host.reportError?.('排版设置部分损坏，已使用默认值；原始数据未自动覆盖，可在设置中重新保存恢复。');
    const merged: RedNoteSettings = {
      ...DEFAULT_REDNOTE_SETTINGS,
      ...clean,
      customFonts: (clean.customFonts as RedNoteFontOption[] | undefined) || [...REDNOTE_FONT_OPTIONS],
    };

    const templateId = isVisibleRedNoteTemplate(merged.templateId)
      ? merged.templateId
      : DEFAULT_REDNOTE_TEMPLATE_ID;

    const fontOptions = new Map<string, RedNoteFontOption>();
    [...REDNOTE_FONT_OPTIONS, ...(merged.customFonts || [])].forEach((font) => {
      fontOptions.set(font.value, font);
    });

    const fontFamily = fontOptions.has(merged.fontFamily)
      ? merged.fontFamily
      : DEFAULT_REDNOTE_SETTINGS.fontFamily;

    return {
      ...merged,
      templateId,
      fontFamily,
      fontSize: clampRedNoteFontSize(merged.fontSize),
      customFonts: Array.from(fontOptions.values()),
    };
  }
}
