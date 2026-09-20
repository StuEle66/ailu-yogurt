export type PublishingTarget = 'wechat' | 'rednote' | 'feishu' | 'x';

export type PublishingTargetActivityTone = 'idle' | 'running' | 'attention';

export interface PublishingTargetActivity {
  tone: PublishingTargetActivityTone;
  label: string;
}

export const IDLE_PUBLISHING_TARGET_ACTIVITY: PublishingTargetActivity = Object.freeze({
  tone: 'idle',
  label: '',
});

export function runningPublishingTargetActivity(label: string): PublishingTargetActivity {
  return {
    tone: 'running',
    label: label.trim() || '正在处理',
  };
}

export function attentionPublishingTargetActivity(label: string): PublishingTargetActivity {
  return {
    tone: 'attention',
    label: label.trim() || '需要处理',
  };
}

export function publishingTargetAccessibleLabel(input: {
  targetLabel: string;
  activity: PublishingTargetActivity;
  selected: boolean;
}): string {
  const parts = [input.targetLabel];
  if (input.activity.tone !== 'idle') parts.push(input.activity.label);
  if (input.selected) parts.push('当前页面');
  return parts.join('，');
}

export const PUBLISHING_TARGETS = [
  { id: 'wechat', label: '公众号' },
  { id: 'rednote', label: '图文' },
  { id: 'feishu', label: '飞书' },
  { id: 'x', label: 'X 文章' },
] as const;
