import { useState, useEffect } from 'react';
import * as api from '../api';
import ConnectAccount from './ConnectAccount';
import Layout from './Layout';
import SidePanel from './SidePanel';
import EmailList from './EmailList';
import EmailReader from './EmailReader';
import Spinner from './Spinner';
import { useAccounts } from '../hooks/useAccounts';
import { useEmails } from '../hooks/useEmails';
import { useRemembered } from '../hooks/useRemembered';

const POLL_INTERVAL_MS = 2 * 60 * 1000;

/**
 * The mail client itself, shared by the web and desktop apps: mailbox
 * switching, the inbox list, search, remembered emails, and the reader.
 *
 * `onSignOut` is given only by the web app (the desktop app has no sign-in).
 * `canSavePasswords` means mailbox passwords can go in the OS keychain.
 */
export default function InboxPage({ onSignOut, canSavePasswords = false }) {
  const {
    accounts, loaded, error: accountsError, active,
    selectAccount, connectAccount, connectDemo, removeAccount, refresh: refreshAccounts,
  } = useAccounts();
  const [addingAccount, setAddingAccount] = useState(false);
  const [selectedUid, setSelectedUid] = useState(null);
  const [searchQuery, setSearchQuery] = useState(null);
  const [hideSeen, setHideSeen] = useState(false);
  const [notice, setNotice] = useState(null);

  // Only a mailbox whose password is available can be read.
  const accountId = active?.connected ? active.id : null;
  const {
    emails, loading, refreshing, error, lastOpen, watermarkUid,
    fetchEmails, setWatermarkManually, markAllSeen,
    searchResults, searchLoading, searchError, search, clearSearch, clearStoredCursors,
  } = useEmails(accountId);
  const {
    remembered, remember, forget, isRemembered,
    error: rememberedError,
  } = useRemembered(accountId);
  const searchMode = searchQuery != null;

  // Load the inbox whenever a mailbox becomes readable.
  useEffect(() => {
    if (accountId) fetchEmails();
  }, [accountId, fetchEmails]);

  // A 401 means the mailbox password is no longer available (web server
  // restart or session expiry), the mailbox was removed elsewhere, or, on
  // the web, that the user is signed out.
  const errorStatus = error?.status;
  const errorAccountId = error?.accountId;
  useEffect(() => {
    if (errorStatus !== 401) return undefined;
    let cancelled = false;
    (async () => {
      if (onSignOut) {
        const session = await api.getSession();
        if (!session.logged_in) {
          if (!cancelled) onSignOut();
          return;
        }
      }
      const list = await refreshAccounts();
      if (cancelled || !list) return;
      setSelectedUid(null);
      // Only ask for a password if that mailbox still exists and is locked;
      // a removed mailbox just drops out of the list.
      if (list.some((a) => a.id === errorAccountId && !a.connected)) {
        setNotice('Your mail connection ended. Enter your mail password to reconnect.');
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [errorStatus, errorAccountId, onSignOut, refreshAccounts]);

  // Leaving the inbox view means the headers on it have been seen. Search
  // results replace the inbox on screen, so leaving during a search does not.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && !searchMode) markAllSeen();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [markAllSeen, searchMode]);

  // Poll for new emails while the window is visible.
  useEffect(() => {
    if (!accountId) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchEmails();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchEmails, accountId]);

  const resetView = () => {
    setSelectedUid(null);
    setSearchQuery(null);
    clearSearch();
  };

  const handleSelectAccount = (id) => {
    if (id === active?.id) return;
    // Leaving a mailbox counts as having seen its inbox, as leaving the page does.
    if (!searchMode) markAllSeen();
    resetView();
    setNotice(null);
    selectAccount(id);
  };

  const handleConnect = async (details) => {
    const result = await connectAccount(details);
    setAddingAccount(false);
    resetView();
    if (details.remember && !result.account.password_saved) {
      setNotice("Connected, but the password couldn't be saved to the keychain. You'll need to enter it again next time.");
    } else {
      setNotice(null);
    }
  };

  const handleDemo = async () => {
    const wasShowing = accountId;
    const result = await connectDemo();
    setAddingAccount(false);
    resetView();
    setNotice(null);
    // Reopening the demo while it is showing starts it over, so reload it.
    if (result.account.id === wasShowing) fetchEmails();
  };

  const handleRemove = async (id) => {
    await removeAccount(id);
    if (id === active?.id) resetView();
  };

  const handleLogout = async () => {
    try {
      await api.signout();
    } catch (caught) {
      setNotice(`Could not sign out: ${caught.message}`);
      return;
    }
    clearStoredCursors();
    onSignOut();
  };

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

  if (!loaded) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-canvas-subtle">
        <Spinner label="Loading your mailboxes" />
      </div>
    );
  }

  const signOut = onSignOut ? handleLogout : undefined;
  const connectNotice = notice || (accountsError && `Could not load your mailboxes: ${accountsError.message}`);

  if (addingAccount || accounts.length === 0) {
    return (
      <ConnectAccount
        onSubmit={handleConnect}
        onDemo={api.isDesktop ? handleDemo : undefined}
        onCancel={accounts.length > 0 ? () => setAddingAccount(false) : undefined}
        onSignOut={signOut}
        notice={connectNotice}
        canSavePasswords={canSavePasswords}
        title={accounts.length > 0 ? 'Add a mailbox' : 'Connect your email'}
      />
    );
  }

  if (!active.connected) {
    const otherConnected = accounts.find((a) => a.connected);
    return (
      <ConnectAccount
        key={active.id}
        onSubmit={handleConnect}
        onCancel={otherConnected ? () => handleSelectAccount(otherConnected.id) : undefined}
        onSignOut={signOut}
        notice={connectNotice}
        canSavePasswords={canSavePasswords}
        initialEmail={active.email}
        title="Reconnect your mailbox"
        subtitle={`Enter the mail password for ${active.email} to open it.`}
      />
    );
  }

  const listError = searchMode ? searchError : error;
  return (
    <Layout
      email={active.email}
      onLogout={signOut}
      homeLink={!api.isDesktop}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      sidebar={
        <SidePanel
          accounts={{
            accounts,
            activeId: active.id,
            onSelect: handleSelectAccount,
            onAdd: () => setAddingAccount(true),
            onRemove: handleRemove,
          }}
          emails={emails}
          remembered={remembered}
          selectedUid={selectedUid}
          onSearch={handleSearch}
          onClearSearch={handleClearSearch}
          onForget={forget}
          onSelectEmail={(email) => setSelectedUid(email.uid)}
          onSelectRemembered={setSelectedUid}
        />
      }
    >
      {selectedUid ? (
        <EmailReader accountId={active.id} emailUid={selectedUid} onBack={() => setSelectedUid(null)} />
      ) : (
        <EmailList
          emails={searchMode ? searchResults : emails}
          loading={searchMode ? searchLoading : loading}
          refreshing={!searchMode && refreshing}
          error={listError?.message || rememberedError}
          lastOpen={lastOpen}
          onSelectEmail={(email) => setSelectedUid(email.uid)}
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
