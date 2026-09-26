import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';
import SidePanel from './SidePanel';

const today = new Date().toISOString();
const EMAILS = [{ uid: 1, subject: 'Hello', from: 'Ann', date: today }];

function mockViewport(mobile) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderLayout({ onSelectEmail = vi.fn() } = {}) {
  render(
    <MemoryRouter>
      <Layout
        email="me@example.com"
        onLogout={vi.fn()}
        sidebar={
          <SidePanel
            emails={EMAILS}
            remembered={[]}
            onSearch={vi.fn()}
            onClearSearch={vi.fn()}
            onForget={vi.fn()}
            onSelectEmail={onSelectEmail}
            onSelectRemembered={vi.fn()}
          />
        }
      >
        <p>Main content</p>
      </Layout>
    </MemoryRouter>,
  );
  return { onSelectEmail };
}

const sidebar = () => screen.getByRole('complementary', { hidden: true });
const isOpen = () => sidebar().className.includes('translate-x-0') && !sidebar().hasAttribute('inert');

describe('Layout on a phone', () => {
  beforeEach(() => mockViewport(true));
  afterEach(() => {
    cleanup();
    delete window.matchMedia;
  });

  it('keeps the closed drawer out of the tab order', () => {
    renderLayout();
    expect(sidebar()).toHaveAttribute('inert');
  });

  it('stays open while expanding a day group, and closes after choosing an email', () => {
    const { onSelectEmail } = renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(isOpen()).toBe(true);
    expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: /Today/ }));
    expect(isOpen()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Hello/ }));
    expect(onSelectEmail).toHaveBeenCalledWith(EMAILS[0]);
    expect(isOpen()).toBe(false);
  });

  it('closes with Escape and after submitting a search', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    const search = screen.getByRole('textbox', { name: /Search emails/ });
    fireEvent.change(search, { target: { value: 'invoice' } });
    fireEvent.submit(search);
    expect(isOpen()).toBe(false);
  });
});

describe('Layout on a wide screen', () => {
  beforeEach(() => mockViewport(false));
  afterEach(() => {
    cleanup();
    delete window.matchMedia;
  });

  it('never makes the sidebar or main pane inert', () => {
    renderLayout();
    expect(sidebar()).not.toHaveAttribute('inert');
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
  });
});
