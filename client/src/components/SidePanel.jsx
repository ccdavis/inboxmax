import SearchBox from './SearchBox';
import RememberedList from './RememberedList';
import DayGroup from './DayGroup';
import { groupByDay } from '../utils/dates';

/** Sidebar content: search, remembered emails, and the inbox browsable by day. */
export default function SidePanel({
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
