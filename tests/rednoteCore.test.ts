vi.mock('obsidian', () => ({ Events: class { trigger() {} }, Modal: class {}, Notice: class {}, Component: class {}, TFile: class {} }));
import { RedNoteSettingsManager } from '../src/rednote/rednote/settings-manager';

test('the publishing module exposes all 13 visible card templates', () => {
  const manager = new RedNoteSettingsManager({ load: async () => null, save: async () => {} });
  expect(manager.getTemplates()).toHaveLength(13);
});

test('settings survive restart and do not overwrite unrelated host data', async () => {
  let data: unknown = { unrelated: 'keep', rednote: { fontSize: 18 } };
  const host = { load: async () => data, save: async (next: unknown) => { data = next; } };
  const manager = new RedNoteSettingsManager(host);
  await manager.load();
  await manager.update({ userName: 'Test author', fontSize: 21 });
  const restored = new RedNoteSettingsManager(host);
  await restored.load();
  expect(restored.getSettings()).toMatchObject({ userName: 'Test author', fontSize: 21 });
  expect(data).toHaveProperty('unrelated', 'keep');
});

test('corrupt settings report recovery and leave stored input untouched', async () => {
  const data = { rednote: { fontSize: 'broken', templateId: 'missing' } };
  const messages: string[] = [];
  const manager = new RedNoteSettingsManager({ load: async () => data, save: async () => {}, reportError: message => messages.push(message) });
  await manager.load();
  expect(manager.getSettings().fontSize).toBe(16);
  expect(manager.getSettings().templateId).toBe('jacky-cover');
  expect(messages.length).toBeGreaterThan(0);
  expect(data.rednote.fontSize).toBe('broken');
});

test('settings retain the distinction between preset and user fonts', async () => {
  const manager = new RedNoteSettingsManager({
    load: async () => ({
      rednote: {
        customFonts: [
          { label: '系统无衬线', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif', isPreset: true },
          { label: '我的字体', value: 'My Local Font', isPreset: false },
        ],
      },
    }),
    save: async () => {},
  });
  await manager.load();
  expect(manager.getSettings().customFonts.find(font => font.label === '系统无衬线')?.isPreset).toBe(true);
  expect(manager.getSettings().customFonts.find(font => font.label === '我的字体')?.isPreset).toBe(false);
});


test('all visible templates describe body cards and keep the legacy yogurt template ID', () => {
  const manager = new RedNoteSettingsManager({ load: async () => null, save: async () => {} });
  const templates = manager.getTemplates();
  expect(templates.filter(template => template.showCover)).toEqual([]);
  expect(templates.find(template => template.id === 'jacky-cover')).toMatchObject({
    name: '酸奶糖', description: '极简白色内容页',
  });
});


test('editing active RedNote settings retains unused legacy cover data', async () => {
  const legacyCover = { coverImage: 'data:image/png;base64,legacy', notesTitle: '旧标题', brandTagline: '旧介绍' };
  let data: unknown = { rednote: legacyCover };
  const manager = new RedNoteSettingsManager({ load: async () => data, save: async next => { data = next; } });
  await manager.load();
  await manager.update({ fontSize: 18 });
  expect(data).toMatchObject({ rednote: { ...legacyCover, fontSize: 18 } });
});
