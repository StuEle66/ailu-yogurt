import type { AgentId } from '../types';
import { loadLocalSkills, type LocalSkill } from './skillDiscovery';

export function filterCreativeSkills(
  skills: LocalSkill[],
  selectedNames: readonly string[],
): LocalSkill[] {
  const available = new Map(skills.map(skill => [skill.name.toLocaleLowerCase(), skill] as const));
  const seen = new Set<string>();
  const ordered: LocalSkill[] = [];
  for (const name of selectedNames) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const skill = available.get(key);
    if (skill) ordered.push(skill);
  }
  return ordered;
}

export async function loadCreativeSkills(
  agentId: AgentId,
  selectedNames: readonly string[],
): Promise<LocalSkill[]> {
  return filterCreativeSkills(await loadLocalSkills(agentId), selectedNames);
}
