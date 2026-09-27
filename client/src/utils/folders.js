// The mail server's own folders, as the app names them.
const LABELS = {
  sent: 'Sent',
  drafts: 'Drafts',
  archive: 'Archive',
  trash: 'Trash',
  junk: 'Junk',
};

export function folderLabel(kind) {
  return LABELS[kind] ?? kind;
}

/** Folders whose mail can go back to the inbox (sent mail and drafts never came from it). */
export function canMoveToInbox(kind) {
  return kind === 'archive' || kind === 'trash' || kind === 'junk';
}

/** The server's name for a folder, when it says more than the app's label. */
export function serverName(folder) {
  return folder.name && folder.name.toLowerCase() !== folderLabel(folder.kind).toLowerCase()
    ? folder.name
    : null;
}
