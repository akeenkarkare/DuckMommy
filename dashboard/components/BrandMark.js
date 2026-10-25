// The brand mark: a yellow rubber duck (the 🦆 emoji renders as a mallard). Same drawing as app/icon.svg.
export default function BrandMark({ size = 28 }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <path d="M8 38c0-6 6-9 12-9h6c-4-3-6-7-6-11 0-8 6-13 13-13s13 5 13 13c0 3-1 5-2 7 6 1 12 4 12 12 0 10-9 17-24 17S8 48 8 38z" fill="#ffc93c" />
      <path d="M44 15c5-1 10 0 13 3-3 3-8 4-13 3z" fill="#ff7a1a" />
      <circle cx="37" cy="14" r="2.6" fill="#141006" />
      <path d="M17 41c6 5 17 6 25 1" fill="none" stroke="#e0a91f" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
