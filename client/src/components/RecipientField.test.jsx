import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ComposeDialog from './ComposeDialog';

const SARAH_WORK = { id: 1, name: 'Sarah Chen', email: 'sarah.chen@acme.example', times_sent: 3 };
const SARAH_HOME = { id: 2, name: 'Sarah Chen', email: 'sarah@home.example', times_sent: 0 };
const SAM = { id: 3, name: null, email: 'sam@x.example', times_sent: 0 };

function renderCompose(suggest = vi.fn(async () => [SARAH_WORK, SARAH_HOME, SAM])) {
  const onClose = vi.fn();
  render(
    <ComposeDialog
      from="me@example.com"
      onSend={vi.fn()}
      onSent={vi.fn()}
      onClose={onClose}
      suggestContacts={suggest}
    />,
  );
  return { suggest, onClose, to: screen.getByRole('combobox', { name: 'To' }) };
}

const type = (input, text) => fireEvent.change(input, { target: { value: text } });
const listbox = () => screen.getByRole('listbox', { name: 'Suggestions for To', hidden: true });
const options = () => within(listbox()).queryAllByRole('option');
const chips = () => screen.queryByRole('list', { name: 'To recipients' });

async function typeAndWait(to, text) {
  type(to, text);
  await waitFor(() => expect(to).toHaveAttribute('aria-expanded', 'true'));
}

describe('recipient suggestions', () => {
  afterEach(cleanup);

  it('suggests entries with their full address, and Enter picks the highlighted one', async () => {
    const { suggest, to } = renderCompose();
    await typeAndWait(to, 'sar');
    expect(suggest).toHaveBeenLastCalledWith('sar');
    expect(options().map((o) => o.textContent)).toEqual([
      'Sarah Chen <sarah.chen@acme.example>',
      'Sarah Chen <sarah@home.example>',
      'sam@x.example',
    ]);
    // The first is pre-selected while the text is not an address yet.
    expect(to).toHaveAttribute('aria-activedescendant', options()[0].id);
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(to, { key: 'Enter' });
    expect(chips()).toHaveTextContent('Sarah Chen <sarah.chen@acme.example>');
    expect(to).toHaveValue('');
    expect(to).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves through suggestions with the arrow keys, wrapping around', async () => {
    const { to } = renderCompose();
    await typeAndWait(to, 'sa');
    fireEvent.keyDown(to, { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(to, { key: 'ArrowDown' });
    fireEvent.keyDown(to, { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(to, { key: 'ArrowUp' });
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');

    // Tab picks too, and stays in the field for the next recipient.
    const tab = fireEvent.keyDown(to, { key: 'Tab' });
    expect(tab).toBe(false);
    expect(chips()).toHaveTextContent('sam@x.example');
  });

  it('picks a suggestion with the mouse without leaving the field', async () => {
    const { to } = renderCompose();
    await typeAndWait(to, 'sarah');
    const option = options()[1];
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(chips()).toHaveTextContent('Sarah Chen <sarah@home.example>');
  });

  it('Escape closes the suggestions but not the message', async () => {
    const { to, onClose } = renderCompose();
    await typeAndWait(to, 'sar');
    fireEvent.keyDown(to, { key: 'Escape' });
    expect(to).toHaveAttribute('aria-expanded', 'false');
    expect(onClose).not.toHaveBeenCalled();
    expect(to).toHaveValue('sar');
  });

  it('leaves out people already added', async () => {
    const { to } = renderCompose();
    await typeAndWait(to, 'sar');
    fireEvent.keyDown(to, { key: 'Enter' });
    await typeAndWait(to, 'sa');
    expect(options().map((o) => o.textContent)).not.toContain('Sarah Chen <sarah.chen@acme.example>');
  });

  it('never swaps a typed complete address for a suggestion', async () => {
    const suggest = vi.fn(async () => [{ id: 9, name: 'Other', email: 'bob@acme.example.org', times_sent: 1 }]);
    const { to } = renderCompose(suggest);
    await typeAndWait(to, 'bob@acme.example');
    expect(to).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(to, { key: 'Enter' });
    expect(chips()).toHaveTextContent(/^bob@acme\.example×$/);
  });

  it('keeps working when suggestions fail', async () => {
    const suggest = vi.fn(async () => {
      throw new Error('offline');
    });
    const { to } = renderCompose(suggest);
    type(to, 'sam@x.example');
    await waitFor(() => expect(suggest).toHaveBeenCalled());
    expect(to).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(to, { key: 'Enter' });
    expect(chips()).toHaveTextContent('sam@x.example');
  });

  it('asks only after a pause and ignores answers to old text', async () => {
    let answer;
    const suggest = vi.fn((query) => new Promise((resolve) => {
      answer = () => resolve(query === 'sa' ? [SAM] : [SARAH_WORK]);
    }));
    const { to } = renderCompose(suggest);
    type(to, 's');
    type(to, 'sa');
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    expect(suggest).toHaveBeenCalledWith('sa');
    type(to, 'sar');
    answer(); // the answer for "sa" arrives after the text changed
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    answer();
    await waitFor(() => expect(options().map((o) => o.textContent)).toEqual(['Sarah Chen <sarah.chen@acme.example>']));
  });

  it('takes a comma inside a quoted name as part of the name', () => {
    const { to } = renderCompose(vi.fn(async () => []));
    type(to, '"Chen');
    fireEvent.keyDown(to, { key: ',' });
    // Not cut off at the comma, and no complaint about "Chen.
    expect(chips()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    type(to, '"Chen, Sarah" <s@x.example>, bob@x.example');
    expect(chips()).toHaveTextContent('Chen, Sarah <s@x.example>');
    expect(within(chips()).getAllByRole('listitem')).toHaveLength(1);
    expect(to).toHaveValue('bob@x.example');
  });

  it('says when recipients are added and removed, and keeps focus in the field', async () => {
    const { to } = renderCompose(vi.fn(async () => []));
    type(to, 'a@x.example');
    fireEvent.keyDown(to, { key: 'Enter' });
    const spoken = () => to.closest('.border-b').querySelector('[aria-live="polite"]');
    expect(spoken()).toHaveTextContent('Added a@x.example');

    const remove = screen.getByRole('button', { name: 'Remove a@x.example' });
    remove.focus();
    fireEvent.click(remove);
    expect(chips()).toBeNull();
    expect(to).toHaveFocus();
    expect(spoken()).toHaveTextContent('Removed a@x.example');

    type(to, 'b@x.example');
    fireEvent.keyDown(to, { key: 'Enter' });
    fireEvent.keyDown(to, { key: 'Backspace' });
    expect(spoken()).toHaveTextContent('Removed b@x.example');
  });
});
