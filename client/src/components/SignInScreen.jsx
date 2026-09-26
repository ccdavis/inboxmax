import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import * as api from '../api';
import { AuthForm, AuthLayout, FormError, FormField, SubmitButton } from './AuthLayout';

export default function SignInScreen({ user, onAuth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Go to the page that sent the user here, or straight to the inbox.
  const from = location.state?.from?.pathname || '/inbox';
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, from, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await api.signin(email, password);
      onAuth({
        user_id: result.user_id,
        email: result.email,
        display_name: result.display_name,
      });
      // The effect above navigates once the user state updates.
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle={
        <>
          Don't have an account?{' '}
          <Link to="/register" className="text-accent hover:text-accent-hover">
            Get started
          </Link>
        </>
      }
    >
      <AuthForm onSubmit={handleSubmit}>
        <FormError>{error}</FormError>
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
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          placeholder="Your password"
        />
        <SubmitButton loading={loading} loadingText="Signing in…">Sign In</SubmitButton>
      </AuthForm>
    </AuthLayout>
  );
}
