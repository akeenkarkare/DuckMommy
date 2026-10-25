// Line icons for the Nest panel: 20px grid, 1.75 stroke, round caps, drawn in currentColor.
function Icon({ label, children, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {children}
    </svg>
  );
}

// Said out loud: a duck's open beak with sound coming out.
export const SaidIcon = (p) => (
  <Icon {...p}><path d="M3 8.5 9 7l-6 4.5" /><path d="M3 8.5v3" /><path d="M12.5 7.5a3.5 3.5 0 0 1 0 5" /><path d="M15.5 5a7 7 0 0 1 0 10" /></Icon>
);

// Signed: an open hand.
export const SignedIcon = (p) => (
  <Icon {...p}><path d="M7 10V4.5a1.25 1.25 0 0 1 2.5 0V9" /><path d="M9.5 8.5V3.5a1.25 1.25 0 0 1 2.5 0V9" /><path d="M12 9V5a1.25 1.25 0 0 1 2.5 0v6.5a5.5 5.5 0 0 1-5.5 5.5h-.5a5 5 0 0 1-4-2l-2-2.8a1.2 1.2 0 0 1 1.9-1.5L7 12.5" /></Icon>
);

// Typed: a keyboard.
export const TypedIcon = (p) => (
  <Icon {...p}><rect x="2" y="5" width="16" height="10" rx="2" /><path d="M5.5 8.5h.01M8.5 8.5h.01M11.5 8.5h.01M14.5 8.5h.01M6.5 11.75h7" /></Icon>
);

// The nest itself: an egg sitting in a woven bowl.
export const NestIcon = (p) => (
  <Icon {...p}><path d="M10 3c-2 0-3.5 2.6-3.5 5 0 .5 0 1 .2 1.5h6.6c.2-.5.2-1 .2-1.5 0-2.4-1.5-5-3.5-5Z" /><path d="M2.5 10h15a7.5 6 0 0 1-15 0Z" /><path d="M5 13.5c2 .8 8 .8 10 0" /></Icon>
);

export const RefreshIcon = (p) => (
  <Icon size={14} {...p}><path d="M16 10a6 6 0 1 1-1.8-4.3" /><path d="M16 3.5V7h-3.5" /></Icon>
);

export const ForgetIcon = (p) => (
  <Icon size={14} {...p}><path d="M5 5l10 10M15 5 5 15" /></Icon>
);

export const SOURCE_ICON = { voice: SaidIcon, sign: SignedIcon, typed: TypedIcon };
