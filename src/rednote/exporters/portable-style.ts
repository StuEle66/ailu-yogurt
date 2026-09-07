/** Exported HTML must carry inline styling when detached from Obsidian's CSS. */
export function applyPortableStyle(element: Element, css: string): void {
  element.setAttribute('style', css);
}
export function setPortableStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value);
}
