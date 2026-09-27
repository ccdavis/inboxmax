import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import AddressBookDialog from './AddressBookDialog';
import SignatureDialog from './SignatureDialog';
import ComposeDialog from './ComposeDialog';
import ConnectAccount from './ConnectAccount';
import Layout from './Layout';
import SidePanel from './SidePanel';
import EmailList from './EmailList';
import EmailReader from './EmailReader';
import FolderView from './FolderView';
import Spinner from './Spinner';
import { useAccounts } from '../hooks/useAccounts';
import { useEmails } from '../hooks/useEmails';
import { useRemembered } from '../hooks/useRemembered';
import { useDrafts } from '../hooks/useDrafts';
import { useSignature } from '../hooks/useSignature';
import { forwardDraft, replyDraft } from '../utils/replies';
import { newId } from '../utils/ids';
import { withSignature } from '../utils/signature';

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
  // Good news across the top: { text, action: { label, onClick } | null },
  // numbered so the same news twice is announced twice.
  const [status, setStatusState] = useState(null);
  const statusCount = useRef(0);
  const setStatus = useCallback((next) => {
    statusCount.current += 1;
    setStatusState(next && { ...next, key: statusCount.current });
  }, []);
  // The open compose dialog: { title, initial, draftId, accountId }, or null.
  const [compose, setCompose] = useState(null);
  // Where focus goes in the list when it next shows: the row of { uid } if
  // it is there, else the next one down (after a move).
  const [listFocus, setListFocus] = useState(null);
  const [folderFocus, setFolderFocus] = useState(null);
  const focusCount = useRef(0);
  const focusList = (uid) => {
    focusCount.current += 1;
    setListFocus({ uid, key: focusCount.current });
  };
  const focusFolder = (uid) => {
    focusCount.current += 1;
    setFolderFocus({ uid, key: focusCount.current });
  };
  const clearListFocus = useCallback(() => setListFocus(null), []);
  const clearFolderFocus = useCallback(() => setFolderFocus(null), []);
  // Moves and undos under way, so a double press does not send two.
  const busyMoves = useRef(new Set());
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  // A server folder being looked through ({ kind, name }), in place of the
  // inbox, and the message open from it. UIDs are per folder, so the
  // folder's is kept apart from the inbox's `selectedUid`.
  const [folder, setFolder] = useState(null);
  const [folderUid, setFolderUid] = useState(null);
  const [folderReload, setFolderReload] = useState(0);

  // Only a mailbox whose password is available can be read.
  const accountId = active?.connected ? active.id : null;
  const {
    emails, loading, refreshing, error, lastOpen, watermarkUid,
    fetchEmails, reload, removeEmail, setWatermarkManually, markAllSeen, markAllSeenNow,
    searchResults, searchLoading, searchError, search, clearSearch, clearStoredCursors,
  } = useEmails(accountId);
  const {
    remembered, remember, forget, isRemembered, fetchRemembered,
    error: rememberedError,
  } = useRemembered(accountId);
  const { drafts, refresh: refreshDrafts } = useDrafts(accountId);
  const { signature, save: saveSignature } = useSignature(accountId);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const searchMode = searchQuery != null;
  // The mailbox on screen now, for work that finishes after a switch.
  const shownAccount = useRef(accountId);
  useEffect(() => {
    shownAccount.current = accountId;
  }, [accountId]);

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
      // A message being written is in its draft (saved as it was typed); it
      // is not brought back in an old state when the mailbox reconnects.
      setCompose(null);
      refreshDrafts();
      // Only ask for a password if that mailbox still exists and is locked;
      // a removed mailbox just drops out of the list.
      if (list.some((a) => a.id === errorAccountId && !a.connected)) {
        setNotice('Your mail connection ended. Enter your mail password to reconnect.');
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [errorStatus, errorAccountId, onSignOut, refreshAccounts, refreshDrafts]);

  // Leaving the inbox view means the headers on it have been seen. Search
  // results and server folders replace the inbox on screen, so leaving from
  // them does not.
  const inboxHidden = searchMode || folder != null;
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && !inboxHidden) markAllSeen();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [markAllSeen, inboxHidden]);

  // The desktop app says when new mail comes in; show it right away.
  useEffect(() => {
    if (!accountId) return undefined;
    return api.onNewMail((id) => {
      if (id === accountId) fetchEmails();
    });
  }, [fetchEmails, accountId]);

  // Poll for new emails while the window is visible.
  useEffect(() => {
    if (!accountId) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchEmails();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchEmails, accountId]);

  const leaveFolder = () => {
    setFolder(null);
    setFolderUid(null);
  };

  /** Start afresh on a mailbox: its inbox, nothing open. The last
   * mailbox's news goes too, so its Undo cannot act here. */
  const resetView = () => {
    setSelectedUid(null);
    setSearchQuery(null);
    clearSearch();
    leaveFolder();
    setStatus(null);
    setCompose(null);
  };

  /** Back from a message to the list, onto its row. */
  const closeMessage = () => {
    focusList(selectedUid);
    setSelectedUid(null);
  };

  /** Show the inbox's message `uid`, leaving any folder. */
  const openInboxEmail = (uid) => {
    leaveFolder();
    setSelectedUid(uid);
  };

  const handleOpenFolder = (next) => {
    setStatus(null);
    setSearchQuery(null);
    clearSearch();
    setSelectedUid(null);
    setFolder(next);
    setFolderUid(null);
    // Onto the folder's heading once it has loaded.
    focusFolder(null);
    // Choosing the open folder again shows it afresh.
    setFolderReload((n) => n + 1);
  };

  /** Put a message from Trash, Archive or Junk back in the inbox. */
  const handleMoveToInbox = async (email) => {
    const accountKey = active.id;
    const from = folder.kind;
    const job = `restore:${from}:${email.uid}`;
    if (busyMoves.current.has(job)) return;
    busyMoves.current.add(job);
    setNotice(null);
    try {
      await api.restoreEmail(accountKey, from, email.message_id);
    } catch (caught) {
      if (shownAccount.current === accountKey) {
        setNotice(`Could not move “${email.subject || '(no subject)'}” to the inbox: ${caught.message}`);
      }
      return;
    } finally {
      busyMoves.current.delete(job);
    }
    if (shownAccount.current !== accountKey) return;
    // Back to the folder, which now lacks it; focus goes to the next one.
    focusFolder(email.uid);
    setFolderUid(null);
    setFolderReload((n) => n + 1);
    setStatus({ text: 'Moved to the inbox.' });
    fetchEmails();
  };

  const handleSelectAccount = (id) => {
    if (id === active?.id) return;
    // Leaving a mailbox counts as having seen its inbox, as leaving the page does.
    if (!inboxHidden) markAllSeen();
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
    // Reopening the demo while it is showing starts it over (marker and
    // remembered emails included), so reload both.
    if (result.account.id === wasShowing) {
      reload();
      fetchRemembered();
    }
  };

  /** Open the compose dialog, for the mailbox on screen. */
  const openCompose = (fields) => setCompose({ ...fields, accountId: active.id });

  /** A new message from a mailto: link in an email. */
  const handleWrite = (initial) => {
    setStatus(null);
    openCompose({ title: 'New message', initial: withSignature(initial, signature, { quoted: false }), draftId: newId() });
  };

  const handleReply = (kind, email) => {
    setStatus(null);
    if (kind === 'forward') {
      openCompose({
        title: 'Forward',
        initial: withSignature(forwardDraft(email, { folder: folder?.kind }), signature),
        draftId: newId(),
      });
    } else {
      openCompose({
        title: kind === 'all' ? 'Reply all' : 'Reply',
        initial: withSignature(replyDraft(email, { me: active.email, all: kind === 'all' }), signature),
        draftId: newId(),
      });
    }
  };

  /** Reopen a saved draft where it was left. */
  const handleOpenDraft = async (draft) => {
    setStatus(null);
    try {
      const { content } = await api.getDraft(active.id, draft.id);
      openCompose({ title: content.title || 'Draft', initial: content, draftId: draft.id, fromDraft: true });
    } catch (caught) {
      setNotice(`Could not open the draft: ${caught.message}`);
      refreshDrafts();
    }
  };

  const handleSent = (receipt, request) => {
    setCompose(null);
    refreshDrafts();
    // An open Sent folder now has one more.
    setFolderReload((n) => n + 1);
    const recipients = [...request.to, ...request.cc, ...request.bcc];
    const first = recipients[0].name || recipients[0].email;
    const who = recipients.length > 1 ? `${first} and ${recipients.length - 1} more` : first;
    if (receipt.saved_to_sent) {
      setNotice(null);
      setStatus({ text: `Message sent to ${who}.` });
    } else {
      setStatus(null);
      setNotice(`Message sent to ${who}, but no copy could be saved in your Sent folder.`);
    }
  };

  const MOVED = { trash: 'Moved to Trash.', archive: 'Archived.' };
  const VERB = { trash: 'delete', archive: 'archive' };

  const handleUndo = async (accountKey, email, from, wasRemembered) => {
    const job = `undo:${email.message_id}`;
    if (busyMoves.current.has(job)) return;
    busyMoves.current.add(job);
    setStatus(null);
    let restoredUid = null;
    try {
      const { uid } = await api.restoreEmail(accountKey, from, email.message_id);
      restoredUid = uid;
      if (shownAccount.current !== accountKey) return;
      // The message is back under a new UID; so is its star. A list row's
      // sender is text, the reader's a list of addresses.
      if (wasRemembered) {
        const sender = typeof email.from === 'string'
          ? email.from
          : email.from?.map((a) => a.name || a.email).join(', ');
        await remember({ uid, subject: email.subject, from: sender, date: email.date });
      }
      setStatus({ text: 'Moved back to the inbox.' });
    } catch (caught) {
      if (shownAccount.current === accountKey) setNotice(`Could not undo: ${caught.message}`);
    } finally {
      busyMoves.current.delete(job);
    }
    if (shownAccount.current !== accountKey) return;
    fetchRemembered();
    await fetchEmails();
    // Onto the message that came back (the Undo button is gone).
    focusList(restoredUid);
  };

  /** Archive or delete a message, from the list or the reader, with Undo. */
  const handleMove = async (email, to) => {
    const accountKey = active.id;
    const job = `move:${email.uid}`;
    if (busyMoves.current.has(job)) return;
    busyMoves.current.add(job);
    const wasRemembered = isRemembered(email.uid);
    setNotice(null);
    try {
      await api.moveEmail(accountKey, email.uid, to);
    } catch (caught) {
      if (shownAccount.current === accountKey) {
        setNotice(`Could not ${VERB[to]} “${email.subject || '(no subject)'}”: ${caught.message}`);
      }
      return;
    } finally {
      busyMoves.current.delete(job);
    }
    // Moved, but the mailbox on screen is another one now.
    if (shownAccount.current !== accountKey) return;
    removeEmail(email.uid);
    // Focus goes on down the list, from the row or the reader that went.
    focusList(email.uid);
    if (selectedUid === email.uid) setSelectedUid(null);
    // A moved message is no longer remembered.
    if (wasRemembered) fetchRemembered();
    setStatus({
      text: MOVED[to],
      // Undo finds the message by its Message-ID; without one it cannot.
      action: email.message_id
        ? { label: 'Undo', onClick: () => handleUndo(accountKey, email, to, wasRemembered) }
        : null,
    });
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
    leaveFolder();
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
  const composeButton = (
    <button
      type="button"
      onClick={() => {
        setStatus(null);
        openCompose({ title: 'New message', initial: withSignature({}, signature), draftId: newId() });
      }}
      className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1.5 text-sm font-medium text-white hover:from-indigo-600 hover:to-violet-600 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <span aria-hidden="true">✎</span> Compose
    </button>
  );
  return (
    <>
    <Layout
      email={active.email}
      onLogout={signOut}
      homeLink={!api.isDesktop}
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      status={status?.text}
      statusKey={status?.key}
      statusAction={status?.action}
      onDismissStatus={() => setStatus(null)}
      actions={composeButton}
      inert={compose?.accountId === active.id || addressBookOpen || signatureOpen}
      sidebar={
        <SidePanel
          accounts={{
            accounts,
            activeId: active.id,
            onSelect: handleSelectAccount,
            onAdd: () => setAddingAccount(true),
            onRemove: handleRemove,
          }}
          onOpenAddressBook={() => setAddressBookOpen(true)}
          onOpenSignature={() => setSignatureOpen(true)}
          drafts={drafts}
          onOpenDraft={handleOpenDraft}
          folders={{ accountId: active.id, activeKind: folder?.kind, onOpen: handleOpenFolder }}
          emails={emails}
          remembered={remembered}
          selectedUid={folder ? null : selectedUid}
          onSearch={handleSearch}
          onClearSearch={handleClearSearch}
          onForget={forget}
          onSelectEmail={(email) => openInboxEmail(email.uid)}
          onSelectRemembered={openInboxEmail}
        />
      }
    >
      {folder ? (
        <>
          {/* Kept while a message from it is open, so going back finds the
              list as it was, scrolled where it was. */}
          <div hidden={folderUid != null} className="h-full">
            <FolderView
              key={folder.kind}
              accountId={active.id}
              folder={folder}
              reloadKey={folderReload}
              focusRequest={folderFocus}
              onFocused={clearFolderFocus}
              onSelect={(email) => setFolderUid(email.uid)}
              onBack={leaveFolder}
            />
          </div>
          {folderUid != null && (
            <EmailReader
              key={folder.kind}
              accountId={active.id}
              emailUid={folderUid}
              folder={folder}
              onBack={() => {
                focusFolder(folderUid);
                setFolderUid(null);
              }}
              me={active.email}
              onReply={handleReply}
              onWrite={handleWrite}
              onMoveToInbox={handleMoveToInbox}
            />
          )}
        </>
      ) : selectedUid ? (
        <EmailReader
          accountId={active.id}
          emailUid={selectedUid}
          onBack={closeMessage}
          me={active.email}
          onReply={handleReply}
          onWrite={handleWrite}
          onMove={handleMove}
        />
      ) : (
        <EmailList
          emails={searchMode ? searchResults : emails}
          loading={searchMode ? searchLoading : loading}
          refreshing={!searchMode && refreshing}
          error={listError?.message || rememberedError}
          lastOpen={lastOpen}
          focusRequest={listFocus}
          onFocused={clearListFocus}
          onSelectEmail={(email) => setSelectedUid(email.uid)}
          isRemembered={isRemembered}
          onToggleRemember={handleToggleRemember}
          searchQuery={searchQuery}
          watermarkUid={watermarkUid}
          onSetWatermark={setWatermarkManually}
          onMarkAllSeen={markAllSeenNow}
          onMove={handleMove}
          hideSeen={hideSeen}
          onToggleHideSeen={() => setHideSeen((h) => !h)}
          onRefresh={fetchEmails}
        />
      )}
    </Layout>
    {compose?.accountId === active.id && (
      <ComposeDialog
        key={compose.draftId}
        from={active.email}
        title={compose.title}
        initial={compose.initial}
        draftId={compose.draftId}
        fromDraft={compose.fromDraft}
        onSaveDraft={async (content) => {
          await api.saveDraft(active.id, compose.draftId, content);
          refreshDrafts();
        }}
        onDeleteDraft={async () => {
          await api.deleteDraft(active.id, compose.draftId);
          refreshDrafts();
        }}
        onSend={(request) => api.sendEmail(active.id, request)}
        onSent={handleSent}
        onClose={({ draftSaved } = {}) => {
          setCompose(null);
          if (draftSaved) setStatus({ text: 'Draft saved.' });
        }}
        suggestContacts={api.searchContacts}
        warnBeforeLeaving={!api.isDesktop}
      />
    )}
    {addressBookOpen && <AddressBookDialog onClose={() => setAddressBookOpen(false)} />}
    {signatureOpen && (
      <SignatureDialog
        email={active.email}
        signature={signature}
        onSave={async (text) => {
          const saved = await saveSignature(text);
          setStatus({ text: saved ? 'Signature saved.' : 'Signature removed.' });
        }}
        onClose={() => setSignatureOpen(false)}
      />
    )}
    </>
  );
}
