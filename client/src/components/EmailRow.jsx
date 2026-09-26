import { formatTime } from '../utils/dates';
import { senderColor, senderInitial, senderName } from '../utils/senders';

const ROW_STATE_CLASSES = {
  // The last-seen marker: the boundary between new and already-scanned rows.
  watermark: 'bg-marker hover:bg-marker-hover border-l-marker-line border-b-2 border-b-marker-line',
  // Headers the user has already scanned: quietly greyed out.
  seen: 'bg-seen hover:bg-seen-hover border-l-transparent border-b border-b-line',
  unseen: 'bg-canvas hover:bg-hover border-l-marker-line border-b border-b-line-subtle',
};

// Row actions stay hidden until hover on wide screens, but always show for
// keyboard focus and on touch-sized layouts.
const ACTION_BUTTON =
  'w-9 h-9 md:w-7 md:h-7 flex items-center justify-center rounded leading-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';
const REVEAL_ON_HOVER = 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100';

export default function EmailRow({ email, onClick, isRemembered, onToggleRemember, isSeen, isWatermark, onSetWatermark }) {
  const state = isWatermark ? 'watermark' : isSeen ? 'seen' : 'unseen';
  const subject = email.subject || '(no subject)';

  return (
    <li
      data-uid={email.uid}
      className={`flex items-center border-l-[3px] pr-1 group transition ${ROW_STATE_CLASSES[state]}`}
    >
      <button
        type="button"
        onClick={() => onClick(email)}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 pr-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
      >
        <span
          className={`${senderColor(email.from)} w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 ${isSeen ? 'opacity-50' : ''}`}
          aria-hidden="true"
        >
          {senderInitial(email.from)}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-xs truncate ${isSeen ? 'font-medium text-ink-muted' : 'font-semibold text-ink'}`}>
            {senderName(email.from)}
          </span>
          <span className={`block text-xs truncate ${isSeen ? 'text-ink-muted' : 'text-ink-soft'}`}>
            {subject}
          </span>
        </span>
        <span className="text-[11px] text-ink-muted shrink-0">{formatTime(email.date)}</span>
      </button>

      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={() => onToggleRemember(email)}
          className={`${ACTION_BUTTON} text-base ${
            isRemembered ? 'text-star hover:opacity-80' : `text-ink-faint hover:text-star ${REVEAL_ON_HOVER}`
          }`}
          title={isRemembered ? 'Forget this' : 'Remember this'}
          aria-label={isRemembered ? `Forget “${subject}”` : `Remember “${subject}”`}
          aria-pressed={isRemembered}
        >
          <span aria-hidden="true">{isRemembered ? '★' : '☆'}</span>
        </button>
        {isWatermark ? (
          <span className={`${ACTION_BUTTON} text-marker-line text-sm`} title="Last seen" role="img" aria-label="Last seen marker">
            <span aria-hidden="true">━</span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onSetWatermark(email.uid)}
            className={`${ACTION_BUTTON} text-sm text-ink-faint hover:text-marker-line ${REVEAL_ON_HOVER}`}
            title="Mark as last seen"
            aria-label={`Mark “${subject}” as the last one seen`}
          >
            <span aria-hidden="true">▾</span>
          </button>
        )}
      </div>
    </li>
  );
}
