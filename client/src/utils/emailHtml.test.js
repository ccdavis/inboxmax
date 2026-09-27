import { describe, expect, it } from 'vitest';
import { hasLoadableImages, sanitizeEmailHtml } from './emailHtml';

describe('sanitizeEmailHtml', () => {
  it('drops ARIA and data attributes, which could make a link read as another', () => {
    const html = sanitizeEmailHtml('<a href="https://evil.example" aria-label="https://yourbank.example" data-x="1">Your bank</a><p aria-hidden="true">Warning</p>');
    expect(html).not.toMatch(/aria-|data-/);
    expect(html).toContain('Warning');
  });

  it('keeps only links that go somewhere', () => {
    const html = sanitizeEmailHtml(
      '<a href="https://ok.example/">web</a> <a href="mailto:a@x.example">mail</a> '
      + '<a href="#top">anchor</a> <a href="/relative">relative</a> <a href="tel:123">phone</a> <a href="javascript:alert(1)">js</a>',
    );
    const template = document.createElement('template');
    template.innerHTML = html;
    expect([...template.content.querySelectorAll('a[href]')].map((a) => a.textContent)).toEqual(['web', 'mail']);
    expect(template.content.textContent).toContain('anchor relative phone js');
  });

  it('says what a blocked image was, and loads nothing', () => {
    const html = sanitizeEmailHtml('<a href="https://bank.example"><img src="https://bank.example/view.png" alt="View statement"></a><img src="https://t.example/p.gif" alt="">');
    expect(html).not.toContain('<img');
    expect(html).toContain('[View statement]');
    expect(hasLoadableImages('<img src="https://t.example/p.gif" alt="">')).toBe(true);
  });
});
