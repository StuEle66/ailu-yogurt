/** The image identities issued for one completed preview render. */
export interface WeChatArticleRenderResult {
  readonly imageBindings: ReadonlyMap<string, string>;
}

/** Keep the mutable Map private; Object.freeze(new Map()) alone permits set/delete. */
export function readonlyImageBindings(entries: Iterable<readonly [string, string]>): ReadonlyMap<string, string> {
  const map = new Map(entries);
  const result: ReadonlyMap<string, string> = Object.freeze({
    get size() { return map.size; },
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach(callback: (value: string, key: string, source: ReadonlyMap<string, string>) => void, thisArg?: unknown) {
      map.forEach((value, key) => callback.call(thisArg, value, key, result));
    },
  });
  return result;
}

/** Normalize a detached publishing HTML copy, never the live preview. */
export function normalizeWeChatPublishingImages(html: string, bindings: ReadonlyMap<string, string>): string {
  const template = document.createElement('template');
  // Inert template only: this markup is never mounted, and publishing sanitizes it afterwards.
  // eslint-disable-next-line no-unsanitized/property -- inert detached markup, never mounted
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    const token = bindings.get(source);
    if (token !== undefined) image.setAttribute('src', token);
    else if (/^blob:/i.test(source.replace(/[\t\n\r]/g, '').trim())) {
      throw new Error(`正文图片未通过本地预检：${source}`);
    }
  }
  return template.innerHTML;
}
