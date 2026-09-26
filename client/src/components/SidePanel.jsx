import SearchBox from './SearchBox';
import AccountList from './AccountList';
import RememberedList from './RememberedList';
import DayGroup from './DayGroup';
import { groupByDay } from '../utils/dates';

/**
 * Sidebar content: search, the user's mailboxes, remembered emails, and the
 * inbox browsable by day. `accounts` is optional so the panel also works
 * without mailbox switching.
 */
export default function SidePanel({
  accounts,
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
