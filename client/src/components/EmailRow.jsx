import { formatTime } from '../utils/dates';
import { senderColor, senderInitial, senderName } from '../utils/senders';
import { ArchiveIcon, TrashIcon } from './icons';

// Each state styles the whole row: its band, its text, and its avatar.
const ROW_STATES = {
  // New since the last visit: the plain list background, full-strength text.
  unseen: {
    row: 'bg-canvas hover:bg-hover border-l-marker-line border-b border-b-line-subtle',
    avatar: '',
    sender: 'font-semibold text-ink',
    subject: 'text-ink',
    time: 'font-medium text-ink-soft',
    icon: 'text-ink-faint',
    ring: 'focus-visible:ring-indigo-500',
  },
  // The last-seen marker: a solid highlight across the list, like a selected
  // message, so where new mail ends is unmistakable.
  watermark: {
    row: 'bg-marker-row hover:bg-marker-row-hover border-l-marker-row border-b border-b-marker-row',
    avatar: 'ring-2 ring-on-marker-row/70',
    sender: 'font-semibold text-on-marker-row',
    subject: 'text-on-marker-row',
    time: 'font-medium text-on-marker-row',
    icon: 'text-on-marker-row/80',
    ring: 'focus-visible:ring-on-marker-row',
  },
  // Already scanned: a recessed grey band with washed-out text.
  seen: {
    row: 'bg-seen hover:bg-seen-hover border-l-transparent border-b border-b-canvas',
    avatar: 'opacity-40 grayscale',
    sender: 'font-normal text-seen-ink',
    subject: 'text-seen-ink',
    time: 'text-seen-ink',
    icon: 'text-seen-ink',
    ring: 'focus-visible:ring-indigo-500',
  },
};

// Row actions stay hidden until hover on wide screens, but always show for
// keyboard focus and on touch-sized layouts.
const ACTION_BUTTON =
  'w-9 h-9 md:w-7 md:h-7 flex items-center justify-center rounded leading-none transition focus:outline-none focus-visible:ring-2';
const REVEAL_ON_HOVER = 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100';

/**
 * One inbox header. Unseen rows are plain, the last-seen marker row is
 * highlighted, and rows older than it are a greyed-out band. `onMove(email,
 * 'archive' | 'trash')` offers Archive and Delete.
 */
export default function EmailRow({ email, onClick, isRemembered, onToggleRemember, isSeen, isWatermark, onSetWatermark, onMove }) {
  const state = ROW_STATES[isWatermark ? 'watermark' : isSeen ? 'seen' : 'unseen'];
  const subject = email.subject || '(no subject)';
  // Amber would vanish on the marker highlight, so a saved star goes white there.
  const starColor = isWatermark ? 'text-on-marker-row' : 'text-star';

  return (
    <li
      data-uid={email.uid}
      className={`flex items-center border-l-[3px] pr-1 group transition ${state.row}`}
    >
      <button
        type="button"
        onClick={() => onClick(email)}
        className={`flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 pr-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset ${state.ring}`}
      >
        <span
          className={`${senderColor(email.from)} w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 ${state.avatar}`}
          aria-hidden="true"
        >
          {senderInitial(email.from)}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-xs truncate ${state.sender}`}>
            {senderName(email.from)}
          </span>
          <span className={`block text-xs truncate ${state.subject}`}>
            {subject}
          </span>
        </span>
        <span className={`text-[11px] shrink-0 ${state.time}`}>
          {formatTime(email.date)}
        </span>
      </button>

      <div className="flex items-center shrink-0">
        {onMove && (
          <>
            <button
              type="button"
              onClick={() => onMove(email, 'archive')}
              className={`${ACTION_BUTTON} ${state.ring} ${state.icon} hover:text-ink ${REVEAL_ON_HOVER}`}
              title="Archive"
              aria-label={`Archive “${subject}”`}
            >
              <ArchiveIcon />
            </button>
            <button
              type="button"
              onClick={() => onMove(email, 'trash')}
              className={`${ACTION_BUTTON} ${state.ring} ${state.icon} hover:text-danger-ink ${REVEAL_ON_HOVER}`}
              title="Delete"
              aria-label={`Delete “${subject}”`}
            >
              <TrashIcon />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => onToggleRemember(email)}
          className={`${ACTION_BUTTON} ${state.ring} text-base ${
            isRemembered ? `${starColor} hover:opacity-80` : `${state.icon} hover:text-star ${REVEAL_ON_HOVER}`
          }`}
          title={isRemembered ? 'Forget this' : 'Remember this'}
          aria-label={isRemembered ? `Forget “${subject}”` : `Remember “${subject}”`}
          aria-pressed={isRemembered}
        >
          <span aria-hidden="true">{isRemembered ? '★' : '☆'}</span>
        </button>
        {isWatermark ? (
          <span
            className="mx-1 shrink-0 rounded-full border border-on-marker-row/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-marker-row"
            role="img"
            aria-label="Last seen marker"
          >
            <span aria-hidden="true">Last seen</span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onSetWatermark(email.uid)}
            className={`${ACTION_BUTTON} ${state.ring} text-sm ${state.icon} hover:text-marker-line ${REVEAL_ON_HOVER}`}
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
