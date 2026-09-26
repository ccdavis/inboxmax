import { useState } from 'react';
import * as api from '../api';
import { AuthForm, AuthLayout, FormError, FormField, SubmitButton } from './AuthLayout';

const LINK_BUTTON =
  'text-sm text-ink-muted hover:text-ink px-2 py-1 rounded transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

/**
 * Add or reconnect a mailbox. `onSubmit(details)` does the connecting and
 * throws on failure. Desktop passes `canSavePasswords` to offer saving the
 * password in the system keychain; the web app keeps it in server memory.
 */
export default function ConnectAccount({
  onSubmit,
  onCancel,
  onSignOut,
  notice,
  initialEmail = '',
  title = 'Connect your email',
  subtitle = 'Connect your IMAP email account to start using Inbox Max.',
  canSavePasswords = false,
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const details = { email, password };
      if (imapHost.trim()) details.imap_host = imapHost.trim();
      if (imapPort) details.imap_port = Number(imapPort);
      if (canSavePasswords) details.remember = remember;
      await onSubmit(details);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const topRight = (onCancel || onSignOut) && (
    <div className="flex gap-2">
      {onCancel && (
        <button type="button" onClick={onCancel} className={LINK_BUTTON}>
          Back to inbox
        </button>
      )}
      {onSignOut && (
        <button type="button" onClick={onSignOut} className={LINK_BUTTON}>
          Sign out
        </button>
      )}
    </div>
  );

  return (
    <AuthLayout
      title={title}
      subtitle={subtitle}
      logoLinksHome={!api.isDesktop}
      topRight={topRight}
    >
      <AuthForm onSubmit={handleSubmit}>
        <FormError>{error || notice}</FormError>
        <FormField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="you@gmail.com"
        />
        <FormField
          label="Password"
          hint="(App Password for Gmail)"
          type="password"
          name="mail-password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          placeholder="Mail or app password"
        />

        {canSavePasswords && (
          <label className="flex items-start gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-indigo-600"
            />
            <span>Remember the password in this computer's keychain</span>
          </label>
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          aria-expanded={showAdvanced}
          aria-controls="advanced-settings"
          className="text-xs text-ink-muted hover:text-ink transition rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced settings
        </button>

        {showAdvanced && (
          <div id="advanced-settings" className="grid grid-cols-[1fr_6rem] gap-3">
            <FormField
              small
              label="IMAP host"
              hint="(auto-detected if blank)"
              type="text"
              name="imap-host"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              placeholder="imap.example.com"
            />
            <FormField
              small
              label="Port"
              type="number"
              name="imap-port"
              inputMode="numeric"
              min={1}
              max={65535}
              value={imapPort}
              onChange={(e) => setImapPort(e.target.value)}
              placeholder="993"
            />
          </div>
        )}

        <SubmitButton loading={loading} loadingText="Connecting…">Connect Email Account</SubmitButton>

        <div className="text-xs text-ink-muted text-center leading-relaxed space-y-2">
          <p>
            Gmail users: enable 2FA then create an{' '}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover underline-offset-2 hover:underline"
            >
              App Password
            </a>
            .
          </p>
          {api.isDesktop ? (
            <p>
              Inbox Max connects straight to your mail server. Passwords you choose not
              to remember are kept only until you quit the app.
            </p>
          ) : (
            <p>
              Your mail password is kept only in the server's memory, never on disk, so
              you'll enter it again after the server restarts.
            </p>
          )}
        </div>
      </AuthForm>
    </AuthLayout>
  );
}
