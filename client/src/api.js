// The app's single entry point to the backend. The transport is chosen at
// build time: HTTP for the web app, Tauri IPC for the desktop app (see the
// `#transport` alias in vite.config.js). Both return the same data shapes.
import { transport } from '#transport';

export { ApiError } from './apiError';

export const isDesktop = transport.isDesktop;

// Signed-in state. Desktop is always signed in and adds `app` details.
export const getSession = () => transport.getSession();

// Web-only user accounts.
export const register = (email, password, displayName) => transport.register(email, password, displayName);
export const signin = (email, password) => transport.signin(email, password);
export const signout = () => transport.signout();

// Mailboxes.
export const listAccounts = () => transport.listAccounts();
/** `details`: { email, password, imap_host?, imap_port?, remember? } */
export const connectAccount = (details) => transport.connectAccount(details);
/** Add or reopen the generated demo mailbox (desktop only). */
export const connectDemo = () => transport.connectDemo();
export const removeAccount = (accountId) => transport.removeAccount(accountId);

// Inbox operations on one mailbox.
export const getEmails = (accountId, since) => transport.getEmails(accountId, since);
export const getEmail = (accountId, uid) => transport.getEmail(accountId, uid);
export const searchEmails = (accountId, query) => transport.searchEmails(accountId, query);
export const setWatermark = (accountId, uid) => transport.setWatermark(accountId, uid);
// Drafts of a mailbox: listed as { id, subject, to, updated_at }; `content`
// is the compose form's state.
export const listDrafts = (accountId) => transport.listDrafts(accountId);
export const getDraft = (accountId, draftId) => transport.getDraft(accountId, draftId);
export const saveDraft = (accountId, draftId, content) => transport.saveDraft(accountId, draftId, content);
export const deleteDraft = (accountId, draftId) => transport.deleteDraft(accountId, draftId);

// The server's own folders, read-only: [{ kind, name }], where `kind` is
// 'sent', 'drafts', 'archive', 'trash' or 'junk' and `name` is what the
// server calls it. Looking through a folder never marks its mail read.
export const listFolders = (accountId) => transport.listFolders(accountId);
export const getFolderEmails = (accountId, folder) => transport.getFolderEmails(accountId, folder);
export const getFolderEmail = (accountId, folder, uid) => transport.getFolderEmail(accountId, folder, uid);
export const downloadFolderAttachment = (accountId, folder, uid, index) =>
  transport.downloadFolderAttachment(accountId, folder, uid, index);

/** Move a message out of the inbox: `to` is 'trash' or 'archive'. */
export const moveEmail = (accountId, uid, to) => transport.moveEmail(accountId, uid, to);
/** Undo a move, finding the message by its Message-ID. Resolves to { uid } in the inbox. */
export const restoreEmail = (accountId, from, messageId) => transport.restoreEmail(accountId, from, messageId);
/**
 * `request`: { to, cc, bcc: [{ name, email }], subject, body, in_reply_to, references }.
 * Resolves to { message_id, saved_to_sent }.
 */
export const sendEmail = (accountId, request) => transport.sendEmail(accountId, request);
export const getRemembered = (accountId) => transport.getRemembered(accountId);
export const rememberEmail = (accountId, uid, data) => transport.rememberEmail(accountId, uid, data);
export const forgetEmail = (accountId, uid) => transport.forgetEmail(accountId, uid);

// The address book: [{ id, email, name, times_sent }].
/** Entries whose address or any word of whose name starts with `query`. */
export const searchContacts = (query) => transport.searchContacts(query);
export const listContacts = () => transport.listContacts();
/** Add an entry or rename one: { email, name }. */
export const saveContact = (contact) => transport.saveContact(contact);
export const deleteContact = (id) => transport.deleteContact(id);

/**
 * Download one attachment of a message. The web app hands it to the
 * browser (resolving to null); the desktop app saves it in Downloads and
 * resolves to { path, filename }.
 */
export const downloadAttachment = (accountId, uid, index) => transport.downloadAttachment(accountId, uid, index);
/** Desktop: show a saved attachment in the file manager. */
export const showInFolder = (path) => transport.showInFolder(path);

/** Open a link from an email outside the app. */
export const openExternal = (url) => transport.openExternal(url);
