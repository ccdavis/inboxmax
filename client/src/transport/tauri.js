// Desktop transport: Tauri IPC commands in the Inbox Max desktop app.
// Commands mirror the HTTP API and return the same JSON shapes.
import { invoke } from '@tauri-apps/api/core';
import { ApiError } from '../apiError';

async function call(command, args) {
  try {
    return await invoke(command, args);
  } catch (caught) {
    // Commands reject with the serialized AppError: { status, message }.
    if (caught && typeof caught === 'object' && 'message' in caught) {
      throw new ApiError(caught.status ?? 500, caught.message);
    }
    throw new ApiError(500, String(caught));
  }
}

const unsupported = () => Promise.reject(new ApiError(400, 'Not available in the desktop app'));

export const transport = {
  isDesktop: true,

  // One local profile: always "signed in", no user accounts.
  getSession: async () => ({ logged_in: true, user: null, app: await call('app_info') }),
  register: unsupported,
  signin: unsupported,
  signout: unsupported,

  listAccounts: () => call('list_accounts'),
  connectAccount: (request) => call('connect_account', { request }),
  connectDemo: () => call('connect_demo'),
  removeAccount: (accountId) => call('remove_account', { accountId }),

  getEmails: (accountId, since) => call('list_emails', { accountId, since: since ?? null }),
  getEmail: (accountId, uid) => call('get_email', { accountId, uid }),
  searchEmails: (accountId, query) => call('search_emails', { accountId, query }),
  setWatermark: (accountId, uid) => call('set_watermark', { accountId, uid }),
  sendEmail: (accountId, request) => call('send_email', { accountId, request }),
  listDrafts: (accountId) => call('list_drafts', { accountId }),
  getDraft: (accountId, draftId) => call('get_draft', { accountId, draftId }),
  saveDraft: (accountId, draftId, content) => call('save_draft', { accountId, draftId, content }),
  deleteDraft: (accountId, draftId) => call('delete_draft', { accountId, draftId }),
  listFolders: (accountId) => call('list_folders', { accountId }),
  getFolderEmails: (accountId, folder) => call('list_folder_emails', { accountId, folder }),
  getFolderEmail: (accountId, folder, uid) => call('get_folder_email', { accountId, folder, uid }),
  moveEmail: (accountId, uid, to) => call('move_email', { accountId, uid, to }),
  restoreEmail: (accountId, from, messageId) => call('restore_email', { accountId, from, messageId }),

  getRemembered: (accountId) => call('list_remembered', { accountId }),
  rememberEmail: (accountId, uid, data) => call('remember_email', { accountId, uid, data }),
  forgetEmail: (accountId, uid) => call('forget_email', { accountId, uid }),

  searchContacts: (query) => call('list_contacts', { query }),
  listContacts: () => call('list_contacts', { query: null }),
  saveContact: (request) => call('save_contact', { request }),
  deleteContact: (id) => call('delete_contact', { id }),

  downloadAttachment: (accountId, uid, index) => call('save_attachment', { accountId, uid, index }),
  downloadFolderAttachment: (accountId, folder, uid, index) =>
    call('save_folder_attachment', { accountId, folder, uid, index }),
  showInFolder: (path) => call('show_in_folder', { path }),

  openExternal: (url) => call('open_external', { url }),
};
