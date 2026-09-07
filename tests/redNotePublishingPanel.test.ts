vi.mock('obsidian', () => ({
  Events: class { trigger() {} }, Modal: class {}, Component: class {}, Notice: class {},
  MarkdownView: class {}, MarkdownRenderer: {}, sanitizeHTMLToDom: () => {},
}));

import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { PUBLISHING_TARGETS } from '../src/ui/publishingTargetActivity';

describe('publishing target choices', () => {
  test('offers RedNote between WeChat and Feishu', () => {
    expect(PUBLISHING_TARGETS.map(target => target.label)).toEqual(['公众号', '小红书', '飞书', 'X 文章']);
  });
});

test('queues a final refresh instead of dropping an update received while rendering', () => {
  const source = fs.readFileSync('src/ui/redNotePublishingPanel.ts', 'utf8');
  expect(source).toContain('this.refreshRequested = true');
  expect(source).toMatch(/const queued = this\.refreshRequested;[\s\S]*?void this\.refresh\(retry\);/);
});


import { DEFAULT_SETTINGS } from '../src/types';
import { initializeRedNoteImport } from '../src/ui/redNotePublishingPanel';

describe('first RedNote open', () => {
  test('imports the legacy layout once and keeps later Ailu customizations', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const legacy = JSON.stringify({ rednote: { userName: 'Imported author', fontSize: 20 }, token: 'must-not-import' });
    let saved = '';
    await initializeRedNoteImport(settings, async () => legacy, async () => { saved = JSON.stringify(settings); });
    expect(settings.rednote).toEqual({ userName: 'Imported author', fontSize: 20 });
    expect(settings.redNoteImport.status).toBe('imported');
    expect(saved).not.toContain('must-not-import');
    settings.rednote.userName = 'Ailu author';
    await initializeRedNoteImport(settings, async () => legacy, async () => {});
    expect(settings.rednote.userName).toBe('Ailu author');
  });
});


test('failed import keeps defaults and permits an explicit retry', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  await initializeRedNoteImport(settings, async () => '{broken', async () => {});
  expect(settings.redNoteImport.status).toBe('failed');
  expect(settings.redNoteImport.error).not.toBe('');
  expect(settings.rednote).toEqual({});
  await initializeRedNoteImport(settings, async () => JSON.stringify({ rednote: { userName: 'Recovered' } }), async () => {}, true);
  expect(settings.rednote.userName).toBe('Recovered');
});

test('failed persistence does not claim import success or replace defaults', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  await initializeRedNoteImport(settings, async () => JSON.stringify({ rednote: { userName: 'Imported' } }), async () => { throw new Error('Disk full'); });
  expect(settings.rednote).toEqual({});
  expect(settings.redNoteImport).toEqual({ status: 'failed', error: 'Disk full' });
});


import { MarkdownView, type App, type TFile } from 'obsidian';
import { RedNotePublishingPanel, readRedNoteSource } from '../src/ui/redNotePublishingPanel';
import { redNoteTemplateSettingsPatch } from '../src/ui/redNotePublishingPanel';
import { REDNOTE_HANDWRITING_FONT } from '../src/rednote';

test('selecting the hand-drawn template keeps the MDFlow handwriting default', () => {
  expect(redNoteTemplateSettingsPatch('handdrawn-notes')).toEqual({
    templateId: 'handdrawn-notes',
    fontFamily: REDNOTE_HANDWRITING_FONT,
  });
  expect(redNoteTemplateSettingsPatch('ocean')).toEqual({ templateId: 'ocean' });
});

test('reads unsaved text from the bound note even if another note is active', async () => {
  const file = { path: 'bound.md' } as TFile;
  const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
    file, editor: { getValue: () => '未保存的正文' },
  });
  const app = { workspace: { getLeavesOfType: () => [{ view }] },
    vault: { read: async () => '旧磁盘内容' } } as unknown as App;
  expect(await readRedNoteSource(app, file)).toBe('未保存的正文');
  expect(await readRedNoteSource(app, { path: 'bound.md' } as TFile)).toBe('未保存的正文');
  expect(await readRedNoteSource(app, { path: 'another.md' } as TFile)).toBe('旧磁盘内容');
});


test('holds the article busy while a layout setting is being saved', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.redNoteImport = { status: 'skipped', error: '' };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const panel = new RedNotePublishingPanel({
    app: {} as App, file: { path: 'bound.md' } as TFile,
    getSettings: () => settings, saveSettings: () => pending, requestRender: () => {}, openSettings: () => {},
  });
  const saving = panel.updateSettings({ fontSize: 22 });
  await Promise.resolve();
  expect(panel.isBusy()).toBe(true);
  release(); await saving;
  expect(panel.isBusy()).toBe(false);
  panel.dispose();
});


test('reports damaged legacy fields and retains usable defaults', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  await initializeRedNoteImport(settings, async () => JSON.stringify({ rednote: { userName: { invalid: true } } }), async () => {});
  expect(settings.redNoteImport.status).toBe('failed');
  expect(settings.rednote).toEqual({});
});
