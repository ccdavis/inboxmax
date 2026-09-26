import SearchBox from './SearchBox';
import AccountList from './AccountList';
import RememberedList from './RememberedList';
import DayGroup from './DayGroup';
import { groupByDay } from '../utils/dates';

/**
 * Sidebar content: search, the user's mailboxes, the address book, remembered
 * emails, and the inbox browsable by day. `accounts` is optional so the panel also works
 * without mailbox switching.
 */
export default function SidePanel({
  accounts,
  onOpenAddressBook,
  emails,
  remembered,
  selectedUid,
  onSearch,
  onClearSearch,
  onForget,
  onSelectEmail,
  onSelectRemembered,
}) {
  const dayGroups = groupByDay(emails);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SearchBox onSearch={onSearch} onClear={onClearSearch} />

      <nav className="flex-1 overflow-y-auto" aria-label="Browse emails">
        {accounts && <AccountList {...accounts} />}

        {onOpenAddressBook && (
          <div className="border-b border-line px-1 py-1">
            <button
              type="button"
              data-closes-sidebar
              onClick={onOpenAddressBook}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink-soft hover:bg-hover hover:text-ink transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <span aria-hidden="true">📇</span> Address book
            </button>
          </div>
        )}

        <RememberedList
          remembered={remembered}
          selectedUid={selectedUid}
          onForget={onForget}
          onSelect={onSelectRemembered}
        />

        {dayGroups.map((group) => (
          <DayGroup
            key={group.key}
            label={group.label}
            emails={group.emails}
            selectedUid={selectedUid}
            onSelectEmail={onSelectEmail}
          />
        ))}
      </nav>
    </div>
  );
}
