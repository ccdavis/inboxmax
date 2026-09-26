export default function Spinner({ label, size = 'md' }) {
  const dimensions = size === 'sm' ? 'w-3.5 h-3.5' : 'w-6 h-6';
  return (
    <div role="status" className="inline-flex">
      <div className={`${dimensions} border-2 border-line border-t-indigo-500 rounded-full animate-spin`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
