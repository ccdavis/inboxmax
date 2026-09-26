import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import * as api from './api';
import LandingPage from './components/LandingPage';
import RegisterScreen from './components/RegisterScreen';
import SignInScreen from './components/SignInScreen';
import ConnectAccount from './components/ConnectAccount';
import Layout from './components/Layout';
import SidePanel from './components/SidePanel';
import EmailList from './components/EmailList';
import EmailReader from './components/EmailReader';
import Spinner from './components/Spinner';
import { useEmails } from './hooks/useEmails';
import { useRemembered } from './hooks/useRemembered';

const POLL_INTERVAL_MS = 2 * 60 * 1000;

function InboxPage({ imapStatus, onSignOut }) {
  const [imapEmail, setImapEmail] = useState(imapStatus?.imap_email || null);
  const [checkingImap, setCheckingImap] = useState(!imapStatus);
  const [selectedUid, setSelectedUid] = useState(null);
  const [searchQuery, setSearchQuery] = useState(null);
  const [hideSeen, setHideSeen] = useState(false);
  const [notice, setNotice] = useState(null);

  const {
    emails, loading, refreshing, error, lastOpen, watermarkUid,
    fetchEmails, setWatermarkManually, markAllSeen,
    searchResults, searchLoading, searchError, search, clearSearch, clearStoredSince,
  } = useEmails(imapEmail);
  const {
    remembered, remember, forget, isRemembered, fetchRemembered,
    error: rememberedError,
  } = useRemembered();
  const searchMode = searchQuery != null;

  // Without status from App (e.g. right after sign-in), ask the server.
  useEffect(() => {
    if (imapStatus) return;
    api.getStatus()
      .then((s) => {
        if (s.imap_connected) setImapEmail(s.imap_email);
      })
      .catch(() => {})
      .finally(() => setCheckingImap(false));
  }, [imapStatus]);

  // Load the inbox whenever an account becomes connected.
  useEffect(() => {
    if (imapEmail) fetchEmails();
  }, [imapEmail, fetchEmails]);

  // The IMAP login lives in server memory, so a server restart or session
  // expiry ends it. Send the user back to the connect screen when that happens.
  const errorStatus = error?.status;
  useEffect(() => {
    if (errorStatus !== 401) return;
    let cancelled = false;
    api.getStatus()
      .then((s) => {
        if (cancelled) return;
        if (!s.logged_in) {
          onSignOut();
        } else if (!s.imap_connected) {
          setSelectedUid(null);
          setImapEmail(null);
          setNotice('Your mail connection ended. Enter your mail password to reconnect.');
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [errorStatus, onSignOut]);

  // Leaving the inbox view means the headers on it have been seen. Search
  // results replace the inbox on screen, so leaving during a search does not.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && !searchMode) markAllSeen();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [markAllSeen, searchMode]);

  // Poll for new emails while the tab is visible.
  useEffect(() => {
    if (!imapEmail) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchEmails();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchEmails, imapEmail]);

  const handleConnect = async (email) => {
    setNotice(null);
    setImapEmail(email);
    await fetchRemembered();
  };

  const handleLogout = async () => {
    try {
      await api.signout();
    } catch (caught) {
      setNotice(`Could not sign out: ${caught.message}`);
      return;
    }
    clearStoredSince();
    onSignOut();
  };

  const handleSelectEmail = (email) => setSelectedUid(email.uid);
  const handleSelectRemembered = (uid) => setSelectedUid(uid);
  const handleBack = () => setSelectedUid(null);

  const handleSearch = (query) => {
    setSearchQuery(query);
    setSelectedUid(null);
    search(query);
  };

  const handleClearSearch = () => {
    if (!searchMode) return;
    setSearchQuery(null);
    setSelectedUid(null);
    clearSearch();
  };

  const handleToggleRemember = async (email) => {
    if (isRemembered(email.uid)) {
      await forget(email.uid);
    } else {
      await remember(email);
    }
  };

  if (checkingImap) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-canvas-subtle">
        <Spinner label="Checking your mail connection" />
      </div>
    );
  }

  if (!imapEmail) {
    return <ConnectAccount onConnect={handleConnect} onSignOut={handleLogout} notice={notice} />;
  }

  const listError = searchMode ? searchError : error;
  return (
    <Layout
      email={imapEmail}
      onLogout={handleLogout}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      sidebar={
        <SidePanel
          emails={emails}
          remembered={remembered}
          selectedUid={selectedUid}
          onSearch={handleSearch}
          onClearSearch={handleClearSearch}
          onForget={forget}
          onSelectEmail={handleSelectEmail}
          onSelectRemembered={handleSelectRemembered}
        />
      }
    >
      {selectedUid ? (
        <EmailReader emailUid={selectedUid} onBack={handleBack} />
      ) : (
        <EmailList
          emails={searchMode ? searchResults : emails}
          loading={searchMode ? searchLoading : loading}
          refreshing={!searchMode && refreshing}
          error={listError?.message || rememberedError}
          lastOpen={lastOpen}
          onSelectEmail={handleSelectEmail}
          isRemembered={isRemembered}
          onToggleRemember={handleToggleRemember}
          searchQuery={searchQuery}
          watermarkUid={watermarkUid}
          onSetWatermark={setWatermarkManually}
          hideSeen={hideSeen}
          onToggleHideSeen={() => setHideSeen((h) => !h)}
          onRefresh={fetchEmails}
        />
      )}
    </Layout>
  );
}

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
  const [imapStatus, setImapStatus] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    api
      .getStatus()
      .then((s) => {
        if (s.logged_in && s.user) {
          setUser(s.user);
          // Pass IMAP status through so InboxPage doesn't need to re-fetch
          setImapStatus({ imap_connected: s.imap_connected, imap_email: s.imap_email });
        }
      })
      .catch(() => {})
      .finally(() => setCheckingAuth(false));
  }, []);

  const handleAuth = (userData) => {
    setUser(userData);
  };

  const handleSignOut = useCallback(() => {
    setUser(null);
    setImapStatus(null);
  }, []);

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
            <InboxPage imapStatus={imapStatus} onSignOut={handleSignOut} />
          </RequireAuth>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;
