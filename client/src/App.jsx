import { useState, useEffect, useRef, useCallback } from 'react';
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

function InboxPage({ user, imapStatus, onSignOut }) {
  const [imapEmail, setImapEmail] = useState(imapStatus?.imap_email || null);
  const [checkingImap, setCheckingImap] = useState(!imapStatus);
  const [selectedUid, setSelectedUid] = useState(null);
  const [searchMode, setSearchMode] = useState(false);
  const [hideSeen, setHideSeen] = useState(false);

  const { emails, loading, refreshing, error, lastOpen, sinceTimestamp, watermarkUid, saveWatermark, fetchEmails, search } = useEmails();
  const { remembered, remember, forget, isRemembered } = useRemembered();

  // Keep refs for the visibilitychange handler (avoids stale closures)
  const emailsRef = useRef(emails);
  const saveWatermarkRef = useRef(saveWatermark);
  emailsRef.current = emails;
  saveWatermarkRef.current = saveWatermark;

  useEffect(() => {
    if (imapStatus) {
      if (imapStatus.imap_connected) {
        setImapEmail(imapStatus.imap_email);
        fetchEmails();
      }
      setCheckingImap(false);
    } else {
      api.getStatus()
        .then((s) => {
          if (s.imap_connected) {
            setImapEmail(s.imap_email);
            fetchEmails();
          }
        })
        .catch(() => {})
        .finally(() => setCheckingImap(false));
    }
  }, []);

  // Auto-save watermark when user tabs away or leaves
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        const currentEmails = emailsRef.current;
        if (currentEmails.length > 0) {
          saveWatermarkRef.current(currentEmails[0].uid);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Poll for new emails every 2 minutes when tab is visible
  const fetchEmailsRef = useRef(fetchEmails);
  fetchEmailsRef.current = fetchEmails;
  useEffect(() => {
    if (!imapEmail) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchEmailsRef.current();
      }
    }, 2 * 60 * 1000);
    return () => clearInterval(id);
  }, [imapEmail]);

  const handleConnect = (email) => {
    setImapEmail(email);
    fetchEmails();
  };

  const handleLogout = async () => {
    try {
      await api.signout();
    } catch {
      // Still clear local state even if API fails
    }
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
    fetchEmails();
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
      displayName={user?.display_name}
      onLogout={handleLogout}
      sidebar={
        <SidePanel
          emails={emails}
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
          emails={emails}
          loading={loading}
          refreshing={refreshing}
          error={error}
          lastOpen={lastOpen}
          sinceTimestamp={sinceTimestamp}
          onSelectEmail={handleSelectEmail}
          isRemembered={isRemembered}
          onToggleRemember={handleToggleRemember}
          searchMode={searchMode}
          watermarkUid={watermarkUid}
          onSetWatermark={handleSetWatermark}
          hideSeen={hideSeen}
          onToggleHideSeen={() => setHideSeen(h => !h)}
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
            <InboxPage user={user} imapStatus={imapStatus} onSignOut={handleSignOut} />
          </RequireAuth>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;
