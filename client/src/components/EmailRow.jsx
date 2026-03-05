import { formatTime } from '../utils/dates';

const COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-orange-500',
];

function getInitial(name) {
  if (!name) return '?';
  // Strip quotes and angle brackets from email-style names
  const clean = name.replace(/['"<>]/g, '').trim();
  return clean.charAt(0).toUpperCase();
}

function getColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export default function EmailRow({ email, onClick, isRemembered, onToggleRemember, compact, isSeen, isWatermark, onSetWatermark }) {
  const initial = getInitial(email.from);
  const color = getColor(email.from);

  if (compact) {
    return (
      <button
        onClick={() => onClick?.(email)}
        className="w-full text-left px-3 py-1.5 hover:bg-slate-100 rounded-md transition text-sm truncate text-slate-600"
      >
        <span className="font-medium text-slate-800">{email.from?.split('<')[0]?.trim() || 'Unknown'}</span>
        <span className="text-slate-400 mx-1">-</span>
        <span>{email.subject || '(no subject)'}</span>
      </button>
    );
  }

  return (
    <div
      data-uid={email.uid}
      onClick={() => onClick?.(email)}
      className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer border-b transition group ${
        isWatermark
          ? 'border-l-4 border-l-indigo-500 border-b-[3px] border-b-indigo-400 bg-indigo-50 hover:bg-indigo-100/80'
          : isSeen
          ? 'bg-gray-100 border-slate-200 hover:bg-gray-200/70'
          : 'border-slate-100 hover:bg-blue-50/60'
      }`}
    >
      <div className={`${color} w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0`}>
        {initial}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={`text-xs truncate ${isSeen ? 'font-medium text-slate-500' : 'font-semibold text-slate-900'}`}>
            {email.from?.split('<')[0]?.trim() || 'Unknown'}
          </span>
        </div>
        <div className={`text-xs truncate ${isSeen ? 'text-slate-400' : 'text-slate-600'}`}>
          {email.subject || '(no subject)'}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[11px] text-slate-400">
          {formatTime(email.date)}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleRemember?.(email);
          }}
          className={`text-base leading-none transition ${
            isRemembered
              ? 'text-amber-400 hover:text-amber-500'
              : 'text-slate-300 hover:text-amber-400 md:opacity-0 md:group-hover:opacity-100'
          }`}
          title={isRemembered ? 'Forget this' : 'Remember this'}
        >
          {isRemembered ? '\u2605' : '\u2606'}
        </button>
        {isWatermark ? (
          <span className="text-indigo-400 text-sm leading-none" title="Last seen" aria-label="Last seen marker">━</span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSetWatermark?.(email.uid);
            }}
            className="text-slate-300 hover:text-indigo-400 text-sm leading-none transition md:opacity-0 md:group-hover:opacity-100"
            title="Mark as last seen"
            aria-label="Mark as last seen"
          >
            ▾
          </button>
        )}
      </div>
    </div>
  );
}
