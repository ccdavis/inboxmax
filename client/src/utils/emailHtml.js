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
// Links that go somewhere: web pages, and addresses to write to. Anything
// else (relative, #anchors, other schemes) would lead nowhere useful.
const USABLE_LINK = /^(https?:|mailto:)/i;

function removeLeavingNoGap(element) {
  const parent = element.parentElement;
  element.remove();
  // Nor the paragraph that held only it.
  if (parent?.matches('p, div') && !parent.textContent.trim() && !parent.children.length) parent.remove();
}

/**
 * Email HTML made safe to show. No style or class attributes: CSS
 * backgrounds are a tracking channel, and dropping inline styles lets the
 * email follow the app's light/dark theme. No ARIA or data attributes
 * either: an aria-label could make a screen reader read a link as a
 * different address. Images, the common tracking channel, are left out
 * unless `images` is set, their descriptions standing in; shown, they load
 * without saying which page asked for them.
 */
export function sanitizeEmailHtml(html, { images = false } = {}) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...TEXT_TAGS, 'img'],
    ALLOWED_ATTR: ['href', 'colspan', 'rowspan', 'src', 'alt', 'width', 'height'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  // A template's content is inert: nothing in it loads.
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll('a[href]')) {
    if (!USABLE_LINK.test(link.getAttribute('href').trim())) {
      link.removeAttribute('href');
      continue;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const image of template.content.querySelectorAll('img')) {
    const alt = image.getAttribute('alt')?.trim();
    if (!images || !LOADABLE_IMAGE.test(image.getAttribute('src') ?? '')) {
      // A blocked "View statement" button still says what it is.
      if (alt) image.replaceWith(`[${alt}]`);
      else removeLeavingNoGap(image);
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
