import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SignInScreen from './SignInScreen';
import RegisterScreen from './RegisterScreen';
import ConnectAccount from './ConnectAccount';

vi.mock('../api', () => ({
  isDesktop: false,
  signin: vi.fn(),
  register: vi.fn(),
}));

import * as api from '../api';

function renderAt(path, element) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
        <Route path="/inbox" element={<p>Inbox page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('auth screens', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('sign-in fields are labelled and set up for password managers', () => {
    renderAt('/signin', <SignInScreen user={null} onAuth={vi.fn()} />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('sign-in shows the server message as is', async () => {
    api.signin.mockRejectedValue(new Error('Invalid email or password'));
    renderAt('/signin', <SignInScreen user={null} onAuth={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Invalid email or password$/);
  });

  it('sign-in goes to the inbox by default', () => {
    renderAt('/signin', <SignInScreen user={{ user_id: 'u', email: 'a@example.com' }} onAuth={vi.fn()} />);
    expect(screen.getByText('Inbox page')).toBeInTheDocument();
  });

  it('registration counts password characters, not UTF-16 units', () => {
    renderAt('/register', <RegisterScreen onAuth={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    // Four emoji: eight UTF-16 code units, but only four characters.
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '😀😀😀😀' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: '😀😀😀😀' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters');
    expect(api.register).not.toHaveBeenCalled();
  });

  it('registration continues to the inbox to connect a mailbox', async () => {
    api.register.mockResolvedValue({ user_id: 'u', email: 'a@example.com', display_name: null });
    const onAuth = vi.fn();
    renderAt('/register', <RegisterScreen onAuth={onAuth} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByText('Inbox page')).toBeInTheDocument();
    expect(onAuth).toHaveBeenCalled();
  });

  it('connect screen offers sign-out, a port override, and shows notices', async () => {
    const onSignOut = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderAt('/connect', <ConnectAccount onSubmit={onSubmit} onSignOut={onSignOut} notice="Reconnect please" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Reconnect please');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /advanced settings/ }));
    fireEvent.change(screen.getByLabelText(/IMAP host/), { target: { value: ' imap.example.com ' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '1993' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Email Account' }));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'secret',
      imap_host: 'imap.example.com',
      imap_port: 1993,
    }));
  });

  it('connect screen offers the keychain when passwords can be saved, and shows failures', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('The mail server rejected this email and password'));
    const onCancel = vi.fn();
    renderAt('/connect', (
      <ConnectAccount onSubmit={onSubmit} onCancel={onCancel} canSavePasswords initialEmail="me@example.com" />
    ));

    expect(screen.getByLabelText('Email')).toHaveValue('me@example.com');
    const remember = screen.getByRole('checkbox', { name: /keychain/ });
    expect(remember).toBeChecked();
    fireEvent.click(remember);
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Email Account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('rejected');
    expect(onSubmit).toHaveBeenCalledWith({ email: 'me@example.com', password: 'nope', remember: false });
    fireEvent.click(screen.getByRole('button', { name: 'Back to inbox' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
