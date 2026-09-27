import { afterEach, describe, expect, it } from 'vitest';
import { focusRow, mayMoveFocus } from './focus';

function list(uids) {
  document.body.innerHTML = `
    <h2 tabindex="-1">Heading</h2>
    <ul>${uids.map((uid) => `<li data-uid="${uid}"><button>Row ${uid}</button></li>`).join('')}</ul>
    <input aria-label="Search">`;
  return { container: document.querySelector('ul'), heading: document.querySelector('h2') };
}

describe('focusRow', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the row, or where it was, or the heading', () => {
    const { container, heading } = list([30, 20, 10]);
    focusRow(container, 20, heading);
    expect(document.activeElement).toHaveTextContent('Row 20');
    focusRow(container, 25, heading);
    expect(document.activeElement).toHaveTextContent('Row 20');
    focusRow(container, 5, heading);
    expect(document.activeElement).toHaveTextContent('Row 10');
    focusRow(container, null, heading);
    expect(document.activeElement).toBe(heading);
  });

  it('with exact, never takes another row for the one asked for', () => {
    const { container, heading } = list([30, 10]);
    focusRow(container, 20, heading, { exact: true });
    expect(document.activeElement).toBe(heading);
  });
});

describe('mayMoveFocus', () => {
  it('moves focus that was lost or is in the list, not focus taken elsewhere', () => {
    const { container } = list([1]);
    document.activeElement.blur();
    expect(mayMoveFocus(container)).toBe(true);
    container.querySelector('button').focus();
    expect(mayMoveFocus(container)).toBe(true);
    document.querySelector('input').focus();
    expect(mayMoveFocus(container)).toBe(false);
    expect(mayMoveFocus(container, { force: true })).toBe(true);
    document.body.innerHTML = '';
  });
});
