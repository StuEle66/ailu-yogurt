import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {JSDOM} from 'jsdom';
const BrowserDOM = JSDOM as unknown as new () => {window: {document: Document; DOMParser: typeof DOMParser}};
const host = vi.hoisted(() => ({frontmatter:vi.fn()}));
vi.mock('obsidian',()=>({
  Component:class {unload(){}},
  getFrontMatterInfo:host.frontmatter,
  // Rendering is the Obsidian host boundary. Keep its supplied text observable in
  // returned HTML, so the converter must remove metadata before the host renders.
  MarkdownRenderer:{render:(_app:unknown,source:string,container:HTMLElement)=>{
    const p=document.createElement('p');p.textContent=source;container.appendChild(p);
  }},
}));
import type {App,TFile} from 'obsidian';
import {MarkdownConverter} from '../src/rednote/converter';

describe('Markdown 转换的元数据边界',()=>{
  beforeEach(()=>{host.frontmatter.mockReset();const dom=new BrowserDOM();vi.stubGlobal('document',dom.window.document);vi.stubGlobal('DOMParser',dom.window.DOMParser);});
  afterEach(()=>vi.unstubAllGlobals());
  it('小红书可用正文不含文件头 YAML，同时保留正文手动分页与原文',async()=>{
    const header='---\ntitle: 图卡验收\n---\n';
    const body='\n# 图卡验收\n\n正文段落\n\n---\n\n第二张卡片\n';
    const source=header+body;
    host.frontmatter.mockReturnValue({exists:true,frontmatter:'title: 图卡验收\n',contentStart:header.length});
    const converter=new MarkdownConverter({} as App);
    const html=await converter.convertToHtml(source,{path:'验收.md'} as TFile);
    const visible=new DOMParser().parseFromString(html,'text/html').body.textContent;
    expect(visible).toBe(body);
    expect(visible).not.toContain('title: 图卡验收');
    expect(source).toBe(header+body);
  });
  it.each([
    '# 正文\n\n---\n\n手动分页后的文字',
    '```yaml\ntitle: 这是正文代码\n---\n```',
    '---\ntitle: 未闭合的正文',
  ])('Obsidian 未确认元数据的输入逐字保留：%s',async(source)=>{
    host.frontmatter.mockReturnValue({exists:false,frontmatter:'',contentStart:0});
    const converter=new MarkdownConverter({} as App);
    const html=await converter.convertToHtml(source,{path:'正文.md'} as TFile);
    expect(new DOMParser().parseFromString(html,'text/html').body.textContent).toBe(source);
  });
});
