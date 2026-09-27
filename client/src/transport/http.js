// Web transport: the Inbox Max HTTP API, authenticated by session cookies.
import { ApiError } from '../apiError';

async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
  });
  if (!res.ok) {
    let message;
    const text = await res.text().catch(() => '');
    try {
      message = JSON.parse(text).error;
    } catch {
      message = text || res.statusText;
    }
    throw new ApiError(res.status, message || 'Request failed');
  }
  return res.json();
}

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const account = (accountId) => `/api/accounts/${encodeURIComponent(accountId)}`;

export const transport = {
  isDesktop: false,

  getSession: () => request('/api/auth/status'),
  register: (email, password, displayName) =>
    request('/api/register', json('POST', { email, password, display_name: displayName || undefined })),
  signin: (email, password) => request('/api/signin', json('POST', { email, password })),
  signout: () => request('/api/signout', { method: 'POST' }),

  listAccounts: () => request('/api/accounts'),
  // The server keeps passwords in session memory only, so `remember` is moot.
  connectAccount: (details) => {
    const body = { ...details };
    delete body.remember;
    return request('/api/accounts', json('POST', body));
  },
  // Mailbox addresses are unique across the server's users, so one shared
  // demo address would only work for the first person to open it.
  connectDemo: () => Promise.reject(new ApiError(400, 'The demo mailbox is only in the desktop app')),
  removeAccount: (accountId) => request(account(accountId), { method: 'DELETE' }),

  getEmails: (accountId, since) =>
    request(`${account(accountId)}/emails${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  getEmail: (accountId, uid) => request(`${account(accountId)}/emails/${uid}`),
  searchEmails: (accountId, query) =>
    request(`${account(accountId)}/search?q=${encodeURIComponent(query)}`),
  setWatermark: (accountId, uid) => request(`${account(accountId)}/watermark`, json('PUT', { uid })),
  sendEmail: (accountId, message) => request(`${account(accountId)}/send`, json('POST', message)),
  listDrafts: (accountId) => request(`${account(accountId)}/drafts`),
  getDraft: (accountId, draftId) => request(`${account(accountId)}/drafts/${encodeURIComponent(draftId)}`),
  saveDraft: (accountId, draftId, content) =>
    request(`${account(accountId)}/drafts/${encodeURIComponent(draftId)}`, json('PUT', { content })),
  deleteDraft: (accountId, draftId) =>
    request(`${account(accountId)}/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' }),
  moveEmail: (accountId, uid, to) => request(`${account(accountId)}/emails/${encodeURIComponent(uid)}/move`, json('POST', { to })),
  restoreEmail: (accountId, from, messageId) => request(`${account(accountId)}/restore`, json('POST', { from, message_id: messageId })),

  getRemembered: (accountId) => request(`${account(accountId)}/remembered`),
  rememberEmail: (accountId, uid, data) => request(`${account(accountId)}/remembered/${uid}`, json('POST', data)),
  forgetEmail: (accountId, uid) => request(`${account(accountId)}/remembered/${uid}`, { method: 'DELETE' }),

  searchContacts: (query) => request(`/api/contacts?q=${encodeURIComponent(query)}`),
  listContacts: () => request('/api/contacts'),
  saveContact: (contact) => request('/api/contacts', json('POST', contact)),
  deleteContact: (id) => request(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // The server sends attachments as downloads, so following the link saves
  // the file without leaving the page.
  downloadAttachment: (accountId, uid, index) => {
    const link = document.createElement('a');
    link.href = `${account(accountId)}/emails/${encodeURIComponent(uid)}/attachments/${encodeURIComponent(index)}`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    return Promise.resolve(null);
  },
  showInFolder: () => Promise.reject(new ApiError(400, 'Not available in the web app')),

  // Links in emails carry target="_blank", so the browser opens them itself.
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  },
};
