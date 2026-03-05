import SearchBox from './SearchBox';
import RememberedList from './RememberedList';
import DayGroup from './DayGroup';
import { groupByDay } from '../utils/dates';

export default function SidePanel({
  emails,
  remembered,
  onSearch,
  onClearSearch,
  onForget,
  onSelectEmail,
  onSelectRemembered,
}) {
  const dayGroups = groupByDay(emails);

  return (
    <div className="flex flex-col h-full bg-slate-50 border-r border-slate-200">
      <SearchBox onSearch={onSearch} onClear={onClearSearch} />

      <div className="flex-1 overflow-y-auto">
        <RememberedList
          remembered={remembered}
          onForget={onForget}
          onSelect={onSelectRemembered}
        />

        {dayGroups.map((group) => (
          <DayGroup
            key={group.label}
            label={group.label}
            emails={group.emails}
            onSelectEmail={onSelectEmail}
          />
        ))}
      </div>
    </div>
  );
}
