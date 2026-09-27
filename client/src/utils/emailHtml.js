// Email HTML, made safe to show in the reader.
import DOMPurify from 'dompurify';

const TEXT_TAGS = [
  'p', 'br', 'b', 'i', 'u', 's', 'strong', 'em', 'small', 'sub', 'sup', 'a', 'div', 'span',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'hr',
];
// Images the reader can load: from the web, or carried in the HTML itself.
// Parts of the message referred to by cid: are not served, so they stay out.
const LOADABLE_IMAGE = /^(https?:|data:image\/)/i;

/**
 * Email HTML made safe to show. No style or class attributes: CSS
 * backgrounds are a tracking channel, and dropping inline styles lets the
 * email follow the app's light/dark theme. Images, the common tracking
 * channel, are left out unless `images` is set, and then load without
 * saying which page asked for them.
 */
export function sanitizeEmailHtml(html, { images = false } = {}) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: images ? [...TEXT_TAGS, 'img'] : TEXT_TAGS,
    ALLOWED_ATTR: images ? ['href', 'colspan', 'rowspan', 'src', 'alt', 'width', 'height'] : ['href', 'colspan', 'rowspan'],
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const image of template.content.querySelectorAll('img')) {
    if (!LOADABLE_IMAGE.test(image.getAttribute('src') ?? '')) {
      const parent = image.parentElement;
      image.remove();
      // Nor the paragraph that held only it, which would leave a gap.
      if (parent?.matches('p, div') && !parent.textContent.trim() && !parent.children.length) parent.remove();
      continue;
    }
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.setAttribute('loading', 'lazy');
  }
  return template.innerHTML;
}

/** Whether the email has images that "Show images" would load. */
export function hasLoadableImages(html) {
  if (!html || !/<img\b/i.test(html)) return false;
  const template = document.createElement('template');
  template.innerHTML = sanitizeEmailHtml(html, { images: true });
  return template.content.querySelector('img') != null;
}
