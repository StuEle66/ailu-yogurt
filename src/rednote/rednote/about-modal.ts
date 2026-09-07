import { Modal } from 'obsidian';
import { RedNoteSettings } from './types';

export class RedNoteAboutModal extends Modal {
  constructor(
    app: Modal['app'],
    private settings: RedNoteSettings
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ailu-rednote-scope', 'ailu-rednote-about-modal');

    const card = contentEl.createDiv({ cls: 'ailu-rednote-about-card' });
    const body = card.createDiv({ cls: 'ailu-rednote-about-body' });

    body.createEl('h2', {
      cls: 'ailu-rednote-about-title',
      text: this.settings.aboutTitle,
    });
    body.createEl('p', { text: this.settings.aboutBio });

    const directionSection = body.createDiv({ cls: 'ailu-rednote-about-section' });
    directionSection.createEl('h3', {
      cls: 'ailu-rednote-about-section-title',
      text: '内容方向',
    });
    const brandTagline = this.settings.brandTagline.trim();
    if (brandTagline) {
      directionSection.createEl('p', {
        cls: 'ailu-rednote-about-section-text',
        text: brandTagline,
      });
    }
    directionSection.createEl('p', {
      cls: 'ailu-rednote-about-section-text',
      text: this.settings.aboutCallout,
    });

    const creditSection = body.createDiv({ cls: 'ailu-rednote-about-section' });
    creditSection.createEl('h3', {
      cls: 'ailu-rednote-about-section-title',
      text: '插件说明',
    });
    creditSection.createEl('p', {
      cls: 'ailu-rednote-about-section-text',
      text: '小红书排版模块迁自酸奶糖 MDFlow（基于 Jackywxsz 的 Jacky-mdflow），现集成于 Ailu。原作者与许可证信息保留在源码中。',
    });

    const footerItems = [this.settings.footerLeftText.trim(), this.settings.userId.trim()].filter(Boolean);
    if (footerItems.length) {
      const footer = card.createDiv({ cls: 'ailu-rednote-about-footer' });
      footerItems.forEach((item, index) => {
        if (index > 0) {
          footer.createDiv({ cls: 'ailu-rednote-about-footer-separator', text: '•' });
        }
        footer.createDiv({ text: item });
      });
    }
  }
}
