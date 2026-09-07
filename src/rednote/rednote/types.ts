export interface RedNoteFontOption {
  label: string;
  value: string;
  isPreset?: boolean;
}

export const REDNOTE_HANDWRITING_FONT = '"Yogurt Handwriting", "Ma Shan Zheng", "Kaiti SC", "STKaiti", "KaiTi", cursive';
export const REDNOTE_PLAYFUL_FONT = '"ZCOOL KuaiLe", "Yogurt Handwriting", "Ma Shan Zheng", "Kaiti SC", "STKaiti", "KaiTi", cursive';

export interface RedNoteTemplatePreset {
  id: string;
  name: string;
  description: string;
  showCover: boolean;
  variables: Record<string, string>;
}

export interface RedNoteSettings {
  templateId: string;
  fontFamily: string;
  fontSize: number;
  userAvatar: string;
  userName: string;
  userId: string;
  showTime: boolean;
  timeFormat: string;
  notesTitle: string;
  brandTagline: string;
  footerLeftText: string;
  footerRightText: string;
  coverImage: string;
  aboutTitle: string;
  aboutBio: string;
  aboutCallout: string;
  supportTitle: string;
  supportText: string;
  supportQrImage: string;
  supportBannerImage: string;
  officialTitle: string;
  officialText: string;
  officialQrImage: string;
  officialBannerImage: string;
  customFonts: RedNoteFontOption[];
}

export type RedNoteAssetField =
  | 'userAvatar'
  | 'coverImage'
  | 'supportQrImage'
  | 'supportBannerImage'
  | 'officialQrImage'
  | 'officialBannerImage';

export const REDNOTE_FONT_OPTIONS: RedNoteFontOption[] = [
  {
    label: '系统无衬线',
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif',
    isPreset: true,
  },
  {
    label: '苹方',
    value: '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif',
    isPreset: true,
  },
  {
    label: '宋体',
    value: '"Songti SC", "STSong", "Noto Serif CJK SC", serif',
    isPreset: true,
  },
  {
    label: '楷体',
    value: '"Kaiti SC", "STKaiti", "KaiTi", serif',
    isPreset: true,
  },
  {
    label: '文楷',
    value: '"LXGW WenKai", "Kaiti SC", "KaiTi", serif',
    isPreset: true,
  },
  {
    label: '手写体（马善政）',
    value: REDNOTE_HANDWRITING_FONT,
    isPreset: true,
  },
  {
    label: '圆润手写（站酷快乐体）',
    value: REDNOTE_PLAYFUL_FONT,
    isPreset: true,
  },
  {
    label: '等宽',
    value: '"SF Mono", "JetBrains Mono", Consolas, Monaco, monospace',
    isPreset: true,
  },
];

export const DEFAULT_REDNOTE_SETTINGS: RedNoteSettings = {
  templateId: 'jacky-cover',
  fontFamily: REDNOTE_FONT_OPTIONS[0].value,
  fontSize: 16,
  userAvatar: '',
  userName: '酸奶糖yogurt',
  userId: '@yogurt_6688',
  showTime: true,
  timeFormat: 'zh-CN',
  notesTitle: '酸奶糖的魔法笔记',
  brandTagline: '清华研究生 × 知识系统化 × AI 协作',
  footerLeftText: '真实 > 完美｜深度 > 套路',
  footerRightText: '酸奶糖yogurt',
  coverImage: '',
  aboutTitle: '关于酸奶糖',
  aboutBio: '酸奶糖yogurt，清华理工科研究生，记录学习、科研、AI 协作与真实成长。',
  aboutCallout: '在清华做科研，在小红书写真实成长，在公众号沉淀方法论。',
  supportTitle: '请我喝咖啡',
  supportText: '如果这套工作流帮你省下了排版时间，欢迎把内容继续写下去。',
  supportQrImage: '',
  supportBannerImage: '',
  officialTitle: '公众号「酸奶糖 yogurt」',
  officialText: '写读研、做科研、用 AI 的真实过程。',
  officialQrImage: '',
  officialBannerImage: '',
  customFonts: [...REDNOTE_FONT_OPTIONS],
};

export function clampRedNoteFontSize(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_REDNOTE_SETTINGS.fontSize;
  return Math.min(28, Math.max(12, Math.round(value)));
}
