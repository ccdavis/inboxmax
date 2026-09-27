import { useEffect, useId, useState } from 'react';
import * as api from '../api';
import DisclosureHeader from './DisclosureHeader';
import Spinner from './Spinner';
import { folderLabel, serverName } from '../utils/folders';

/**
 * The mail server's own folders (Sent, Junk, Trash and so on), for looking
 * through. Inbox Max works from the inbox, so they stay folded away until
 * asked for, and are only fetched then.
 */
export default function FoldersList({ accountId, activeKind, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  // Tagged with their mailbox so a switch never shows another's folders.
  const [loaded, setLoaded] = useState({ accountId: null, folders: null, error: null });
  const listId = useId();
  const current = loaded.accountId === accountId ? loaded : null;

  useEffect(() => {
    if (!expanded || !accountId || current) return undefined;
    let cancelled = false;
    api.listFolders(accountId)
      .then((folders) => {
        if (!cancelled) setLoaded({ accountId, folders: Array.isArray(folders) ? folders : [], error: null });
      })
      .catch((caught) => {
        if (!cancelled) setLoaded({ accountId, folders: null, error: caught.message });
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, accountId, current]);

  const retry = () => setLoaded({ accountId: null, folders: null, error: null });

  return (
    <div className="border-b border-line">
      <DisclosureHeader
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={listId}
        units={['folder', 'folders']}
        count={current?.folders?.length ?? null}
        className="text-ink-muted hover:bg-hover"
      >
        <span>Server folders</span>
      </DisclosureHeader>
      {expanded && (
        <div id={listId} className="pb-1">
          {!current && (
            <div className="px-3 py-2">
              <Spinner size="sm" label="Loading folders" />
            </div>
          )}
          {current?.error && (
            <p role="alert" className="px-3 py-1.5 text-xs text-danger-ink">
              Could not load folders: {current.error}{' '}
              <button type="button" onClick={retry} className="underline hover:no-underline">
                Try again
              </button>
            </p>
          )}
          {current?.folders?.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-ink-muted">The mail server has no other folders.</p>
          )}
          {current?.folders?.length > 0 && (
            <ul>
              {current.folders.map((folder) => {
                const alias = serverName(folder);
                const active = folder.kind === activeKind;
                return (
                  <li key={folder.kind}>
                    <button
                      type="button"
                      data-closes-sidebar
                      onClick={() => onOpen(folder)}
                      aria-current={active ? 'page' : undefined}
                      className={`flex w-full items-baseline gap-2 truncate px-3 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
                        active ? 'bg-marker text-accent font-medium' : 'text-ink-soft hover:bg-hover hover:text-ink'
                      }`}
                    >
                      <span>{folderLabel(folder.kind)}</span>
                      {alias && <span className="truncate text-xs text-ink-muted">({alias})</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
