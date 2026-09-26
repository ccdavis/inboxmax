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
export const removeAccount = (accountId) => transport.removeAccount(accountId);

// Inbox operations on one mailbox.
export const getEmails = (accountId, since) => transport.getEmails(accountId, since);
export const getEmail = (accountId, uid) => transport.getEmail(accountId, uid);
export const searchEmails = (accountId, query) => transport.searchEmails(accountId, query);
export const setWatermark = (accountId, uid) => transport.setWatermark(accountId, uid);
export const getRemembered = (accountId) => transport.getRemembered(accountId);
export const rememberEmail = (accountId, uid, data) => transport.rememberEmail(accountId, uid, data);
export const forgetEmail = (accountId, uid) => transport.forgetEmail(accountId, uid);

/** Open a link from an email outside the app. */
export const openExternal = (url) => transport.openExternal(url);
