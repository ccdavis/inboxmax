// The hosted web app: landing page, user accounts, and the inbox.
import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import * as api from './api';
import LandingPage from './components/LandingPage';
import RegisterScreen from './components/RegisterScreen';
import SignInScreen from './components/SignInScreen';
import InboxPage from './components/InboxPage';
import Spinner from './components/Spinner';

function RequireAuth({ user, children }) {
  const location = useLocation();
  if (!user) {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }
  return children;
}

function NotFound() {
  return (
    <div className="min-h-dvh bg-gradient-to-br from-canvas-subtle to-canvas-deep flex flex-col items-center justify-center p-4">
      <h1 className="text-6xl font-bold text-ink-faint">404</h1>
      <p className="text-ink-muted mt-2">Page not found</p>
      <Link to="/" className="mt-4 text-accent hover:text-accent-hover text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">
        Go home
      </Link>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    api
      .getSession()
      .then((s) => {
        if (s.logged_in && s.user) setUser(s.user);
      })
      .catch(() => {})
      .finally(() => setCheckingAuth(false));
  }, []);

  const handleAuth = (userData) => {
    setUser(userData);
  };

  const handleSignOut = useCallback(() => setUser(null), []);

  if (checkingAuth) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-canvas-subtle">
        <Spinner label="Loading" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={<LandingPage user={user} onSignOut={handleSignOut} />}
      />
      <Route
        path="/register"
        element={
          user ? <Navigate to="/inbox" replace /> : <RegisterScreen onAuth={handleAuth} />
        }
      />
      <Route
        path="/signin"
        element={<SignInScreen user={user} onAuth={handleAuth} />}
      />
      <Route
        path="/inbox"
        element={
          <RequireAuth user={user}>
            <InboxPage onSignOut={handleSignOut} />
          </RequireAuth>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;
