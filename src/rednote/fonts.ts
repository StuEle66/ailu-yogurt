import type { App } from 'obsidian';
/** Load the exact two offline fonts used by MDFlow, returning an unload callback. */
export async function loadBundledFonts(app: App, pluginDir: string): Promise<() => void> {
  const loaded: FontFace[] = [];
  for (const [family, file, format] of [
    ['Yogurt Handwriting', 'MaShanZheng-Regular.woff2', 'woff2'],
    ['ZCOOL KuaiLe', 'ZCOOLKuaiLe-Regular.ttf', 'truetype'],
  ]) {
    const url = app.vault.adapter.getResourcePath(`${pluginDir}/assets/fonts/${file}`);
    const font = new FontFace(family, `url("${url}") format("${format}")`, {style:'normal',weight:'400',display:'swap'});
    try {
      await font.load();
      (document.fonts as unknown as {add(font: FontFace): void}).add(font);
      loaded.push(font);
    } catch (error) {
      for (const item of loaded) (document.fonts as unknown as {delete(font: FontFace): void}).delete(item);
      throw new Error(`离线字体加载失败：${family}。请检查插件 assets/fonts 是否完整。`, {cause: error});
    }
  }
  return () => loaded.forEach(font => (document.fonts as unknown as {delete(font: FontFace): void}).delete(font));
}
