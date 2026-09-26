import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../api';
import { AuthForm, AuthLayout, FormError, FormField, SubmitButton } from './AuthLayout';

const MIN_PASSWORD_CHARS = 8;

export default function RegisterScreen({ onAuth }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    // Count characters the way the server does, not UTF-16 code units.
    if (Array.from(password).length < MIN_PASSWORD_CHARS) {
      setError(`Password must be at least ${MIN_PASSWORD_CHARS} characters`);
      return;
    }

    setLoading(true);
    try {
      const result = await api.register(email, password, displayName || undefined);
      onAuth({
        user_id: result.user_id,
        email: result.email,
        display_name: result.display_name,
      });
      // Next step for a new account: connect a mailbox.
      navigate('/inbox', { replace: true });
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle={
        <>
          Already have an account?{' '}
          <Link to="/signin" className="text-accent hover:text-accent-hover">
            Sign in
          </Link>
        </>
      }
    >
      <AuthForm onSubmit={handleSubmit}>
        <FormError>{error}</FormError>
        <FormField
          label="Display Name"
          hint="(optional)"
          type="text"
          name="name"
          autoComplete="nickname"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Jane"
        />
        <FormField
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="you@example.com"
        />
        <FormField
          label="Password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          placeholder={`At least ${MIN_PASSWORD_CHARS} characters`}
        />
        <FormField
          label="Confirm Password"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          placeholder="Repeat your password"
        />
        <SubmitButton loading={loading} loadingText="Creating account…">Create Account</SubmitButton>
      </AuthForm>
    </AuthLayout>
  );
}
