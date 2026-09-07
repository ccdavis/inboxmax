import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import * as api from './api';
import LandingPage from './components/LandingPage';
import RegisterScreen from './components/RegisterScreen';
import SignInScreen from './components/SignInScreen';
import ConnectAccount from './components/ConnectAccount';
import Layout from './components/Layout';
import SidePanel from './components/SidePanel';
import EmailList from './components/EmailList';
import EmailReader from './components/EmailReader';
import { useEmails } from './hooks/useEmails';
import { useRemembered } from './hooks/useRemembered';

function InboxPage({ imapStatus, onSignOut }) {
  const [imapEmail, setImapEmail] = useState(imapStatus?.imap_email || null);
  const [checkingImap, setCheckingImap] = useState(!imapStatus);
  const [selectedUid, setSelectedUid] = useState(null);
  const [searchMode, setSearchMode] = useState(false);
  const [hideSeen, setHideSeen] = useState(false);
  const [signOutError, setSignOutError] = useState(null);

  const {
    emails, searchResults, loading, refreshing, error, lastOpen, watermarkUid,
    saveWatermark, fetchEmails, search, clearSearch, clearStoredSince,
  } = useEmails(imapEmail);
  const {
    remembered, remember, forget, isRemembered, fetchRemembered,
    error: rememberedError,
  } = useRemembered();

  useEffect(() => {
    if (imapStatus) {
      if (imapStatus.imap_connected) {
        fetchEmails(undefined, imapStatus.imap_email);
      }
    } else {
      api.getStatus()
        .then((s) => {
          if (s.imap_connected) {
            setImapEmail(s.imap_email);
            fetchEmails(undefined, s.imap_email);
          }
        })
        .catch(() => {})
        .finally(() => setCheckingImap(false));
    }
  }, [fetchEmails, imapStatus]);

  // Auto-save watermark when user tabs away or leaves
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && !searchMode) {
        if (emails.length > 0) {
          saveWatermark(emails[0].uid);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [emails, saveWatermark, searchMode]);

  // Poll for new emails every 2 minutes when tab is visible
  useEffect(() => {
    if (!imapEmail) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchEmails(undefined, imapEmail);
      }
    }, 2 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchEmails, imapEmail]);

  const handleConnect = async (email) => {
    setImapEmail(email);
    await fetchEmails(undefined, email);
    await fetchRemembered();
  };

  const handleLogout = async () => {
    try {
      await api.signout();
    } catch (caught) {
      setSignOutError(`Could not sign out: ${caught.message}`);
      return;
    }
    clearStoredSince();
    onSignOut();
  };

  const handleSelectEmail = (email) => setSelectedUid(email.uid);
  const handleSelectRemembered = (uid) => setSelectedUid(uid);
  const handleBack = () => setSelectedUid(null);

  const handleSearch = (query) => {
    setSearchMode(true);
    setSelectedUid(null);
    search(query);
  };

  const handleClearSearch = () => {
    setSearchMode(false);
    setSelectedUid(null);
    clearSearch();
    fetchEmails(undefined, imapEmail);
  };

  const handleToggleRemember = async (email) => {
    if (isRemembered(email.uid)) {
      await forget(email.uid);
    } else {
      await remember(email);
    }
  };

  const handleSetWatermark = useCallback((uid) => {
    saveWatermark(uid);
  }, [saveWatermark]);

  const displayedEmails = searchMode ? searchResults : emails;

  if (checkingImap) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-50">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
      </div>
    );
  }

  if (!imapEmail) {
    return <ConnectAccount onConnect={handleConnect} />;
  }

  return (
    <Layout
      email={imapEmail}
      onLogout={handleLogout}
      notice={signOutError}
      sidebar={
        <SidePanel
          emails={displayedEmails}
          remembered={remembered}
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
          emails={displayedEmails}
          loading={loading}
          refreshing={refreshing}
          error={error || rememberedError}
          lastOpen={lastOpen}
          onSelectEmail={handleSelectEmail}
          isRemembered={isRemembered}
          onToggleRemember={handleToggleRemember}
          searchMode={searchMode}
          watermarkUid={watermarkUid}
          onSetWatermark={handleSetWatermark}
          hideSeen={hideSeen}
          onToggleHideSeen={() => setHideSeen(h => !h)}
          onRefresh={() => fetchEmails(undefined, imapEmail)}
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
    <div className="min-h-dvh bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col items-center justify-center p-4">
      <h1 className="text-6xl font-bold text-slate-300">404</h1>
      <p className="text-slate-500 mt-2">Page not found</p>
      <a href="/" className="mt-4 text-indigo-500 hover:text-indigo-600 text-sm">
        Go home
      </a>
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

  const handleSignOut = () => {
    setUser(null);
    setImapStatus(null);
  };

  if (checkingAuth) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-slate-50">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
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
          user ? <Navigate to="/" replace /> : <RegisterScreen onAuth={handleAuth} />
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
