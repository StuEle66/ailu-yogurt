export interface CuratedCreativeSkill {
  name: string;
  displayName: string;
  category: '起稿' | '改编' | '体检' | '视觉';
}

export const CREATIVE_SKILL_PRESET_VERSION = 1;

export const CURATED_CREATIVE_SKILLS: readonly CuratedCreativeSkill[] = [
  { name: '点子起稿', displayName: '点子起稿', category: '起稿' },
  { name: '酸奶糖创作核心', displayName: '酸奶糖创作核心', category: '改编' },
  { name: 'daily-ai-learning-writer', displayName: 'AI 日更', category: '起稿' },
  { name: 'moments_generator', displayName: '朋友圈文案', category: '起稿' },
  { name: '一稿多发', displayName: '一稿多发', category: '改编' },
  { name: 'chai-jie-bao-kuan', displayName: '拆解爆款', category: '体检' },
  { name: '公众号长文体检', displayName: '公众号长文体检', category: '体检' },
  { name: '公众号合规', displayName: '公众号合规', category: '体检' },
  { name: '公众号自检', displayName: '公众号自检', category: '体检' },
  { name: 'baoyu-article-illustrator', displayName: '文章配图', category: '视觉' },
  { name: 'generate-wechat-summary-infographic', displayName: '公众号摘要图', category: '视觉' },
  { name: 'guizang-social-card-skill', displayName: '社交图卡', category: '视觉' },
  { name: '优化提示词', displayName: '优化提示词', category: '改编' },
] as const;

export const CURATED_CREATIVE_SKILL_NAMES = CURATED_CREATIVE_SKILLS.map(skill => skill.name);

const CURATED_BY_NAME = new Map(
  CURATED_CREATIVE_SKILLS.map(skill => [skill.name.toLocaleLowerCase(), skill] as const),
);

export function curatedCreativeSkill(name: string): CuratedCreativeSkill | null {
  return CURATED_BY_NAME.get(name.toLocaleLowerCase()) ?? null;
}

export function mergeCuratedCreativeSkills(selectedNames: readonly string[]): string[] {
  const seen = new Set(selectedNames.map(name => name.toLocaleLowerCase()));
  const merged = [...selectedNames];
  for (const name of CURATED_CREATIVE_SKILL_NAMES) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(name);
  }
  return merged;
}
