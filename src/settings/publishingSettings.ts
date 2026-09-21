import {
  SELECTABLE_WECHAT_THEME_DEFINITIONS,
  type WeChatThemeId,
} from '../wechat/themes';
import {
  DEFAULT_WECHAT_BODY_FONT_ID,
  DEFAULT_WECHAT_BODY_FONT_SIZE,
  normalizeWeChatBodyFontId,
  normalizeWeChatBodyFontSize,
  type WeChatBodyFontId,
} from '../wechat/typography';

export type PublishingTransportId = 'dedicatedChrome' | 'localRelay';

export interface PublishingSettings {
  /** Local rendering never depends on the selected upload transport. */
  themeId: WeChatThemeId;
  /** Body typography is independent from the selected visual template. */
  bodyFontId: WeChatBodyFontId;
  /** Integer pixels from 14 to 20; 0 keeps the template's original size. */
  bodyFontSize: number;
  transport: PublishingTransportId;
  transportMigrationVersion: 1;
  relayUrl: string;
  appId: string;
  confirmBeforeUpload: boolean;
  verifyAfterUpload: boolean;
}

export const DEFAULT_PUBLISHING_SETTINGS: PublishingSettings = {
  themeId: 'paper-ink',
  bodyFontId: DEFAULT_WECHAT_BODY_FONT_ID,
  bodyFontSize: DEFAULT_WECHAT_BODY_FONT_SIZE,
  transport: 'dedicatedChrome',
  transportMigrationVersion: 1,
  relayUrl: '',
  appId: '',
  confirmBeforeUpload: true,
  verifyAfterUpload: true,
};

export function normalizePublishingSettings(value: unknown): PublishingSettings {
  const source = isRecord(value) ? value : {};
  const relayUrl = stringValue(source.relayUrl);
  const appId = stringValue(source.appId);
  const migrated = source.transportMigrationVersion === 1;
  const transport: PublishingTransportId = migrated
    ? source.transport === 'localRelay' ? 'localRelay' : 'dedicatedChrome'
    : source.transport === 'localRelay' && relayUrl && appId
      ? 'localRelay'
      : 'dedicatedChrome';
  return {
    // Retired generated themes migrate to Paper Ink; deterministic local templates remain selectable.
    themeId: selectableThemeId(source.themeId),
    bodyFontId: normalizeWeChatBodyFontId(source.bodyFontId),
    bodyFontSize: normalizeWeChatBodyFontSize(source.bodyFontSize),
    transport,
    transportMigrationVersion: 1,
    relayUrl,
    appId,
    // Upload always stays a user-confirmed, read-back-verified action.
    confirmBeforeUpload: true,
    verifyAfterUpload: true,
  };
}

function selectableThemeId(value: unknown): WeChatThemeId {
  return SELECTABLE_WECHAT_THEME_DEFINITIONS.some(theme => theme.id === value)
    ? value as WeChatThemeId
    : 'paper-ink';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
