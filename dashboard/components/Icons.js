// Small line icons drawn for Duck Mommy, used instead of emoji everywhere (emoji read as generic).
// 20px grid, 1.8 stroke, currentColor. Same style as NestIcons.js.

function Svg({ size = 18, label, children }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {children}
    </svg>
  );
}

export const BellIcon = (p) => <Svg {...p}><path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 1.5h-13z" /><path d="M8.5 17.5a1.6 1.6 0 0 0 3 0" /></Svg>;
export const DoorIcon = (p) => <Svg {...p}><path d="M5 18V3h10v15" /><path d="M3 18h14" /><circle cx="12" cy="11" r="0.6" fill="currentColor" /></Svg>;
export const PhoneIcon = (p) => <Svg {...p}><path d="M6 3h3l1 4-2 1.2a9 9 0 0 0 3.8 3.8L13 10l4 1v3a2 2 0 0 1-2 2A12 12 0 0 1 4 5a2 2 0 0 1 2-2z" /></Svg>;
export const SirenIcon = (p) => <Svg {...p}><path d="M5 15v-4a5 5 0 0 1 10 0v4" /><path d="M3 15h14v2.5H3z" /><path d="M10 2.5v1.5M3.5 5l1 1M16.5 5l-1 1" /></Svg>;
export const MegaphoneIcon = (p) => <Svg {...p}><path d="M3 8v4h3l7 4V4L6 8z" /><path d="M6 12l1 4.5h2l-.8-3.5" /><path d="M16 8.5a2.5 2.5 0 0 1 0 3" /></Svg>;
export const SpeakerIcon = (p) => <Svg {...p}><path d="M3 8v4h3l5 4V4L6 8z" /><path d="M14 7.5a3.5 3.5 0 0 1 0 5M16.5 5a7 7 0 0 1 0 10" /></Svg>;
export const CameraIcon = (p) => <Svg {...p}><path d="M3 6.5h3l1.5-2h5L14 6.5h3v9.5H3z" /><circle cx="10" cy="11" r="3" /></Svg>;
export const EyeIcon = (p) => <Svg {...p}><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" /><circle cx="10" cy="10" r="2.3" /></Svg>;
export const StepsIcon = (p) => <Svg {...p}><path d="M6 3c1.6 0 2.3 2 2 4.5S6.8 11 5.8 11 3.9 9 4 7s.4-4 2-4z" /><path d="M5.5 13.5h2.4" /><path d="M14 7c1.6 0 2.1 2 2 4.5s-1.3 3.5-2.2 3.5-1.9-2-1.8-4S12.4 7 14 7z" /><path d="M13.5 17.5h2.4" /></Svg>;
export const HandIcon = (p) => <Svg {...p}><path d="M7 10V4.5a1.2 1.2 0 0 1 2.4 0V9" /><path d="M9.4 8.5V3.5a1.2 1.2 0 0 1 2.4 0v5" /><path d="M11.8 8.5V4.5a1.2 1.2 0 0 1 2.4 0V12a5.5 5.5 0 0 1-5.5 5.5H8.5A4.5 4.5 0 0 1 4.6 15L3 12.2a1.2 1.2 0 0 1 2-1.3L7 13" /></Svg>;
export const TargetIcon = (p) => <Svg {...p}><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><circle cx="10" cy="10" r="0.6" fill="currentColor" /></Svg>;
export const CupIcon = (p) => <Svg {...p}><path d="M4 7h10v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" /><path d="M14 8.5h1a2 2 0 0 1 0 4h-1" /><path d="M7 2.5v2M10 2.5v2" /></Svg>;
export const CheckIcon = (p) => <Svg {...p}><path d="M4 10.5l4 4 8-9" /></Svg>;
export const CloseIcon = (p) => <Svg {...p}><path d="M5 5l10 10M15 5L5 15" /></Svg>;
export const PinIcon = (p) => <Svg {...p}><path d="M10 18v-5" /><path d="M6.5 3h7l-1 4 2.5 3H5l2.5-3z" /></Svg>;
export const CalendarIcon = (p) => <Svg {...p}><rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M3 8.5h14M7 2.5v3.5M13 2.5v3.5" /></Svg>;
export const ClockIcon = (p) => <Svg {...p}><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></Svg>;
export const AlertIcon = (p) => <Svg {...p}><path d="M10 3l8 14H2z" /><path d="M10 8.5v3.5" /><circle cx="10" cy="14.6" r="0.6" fill="currentColor" /></Svg>;
export const LinkOutIcon = (p) => <Svg {...p}><path d="M8 4H4v12h12v-4" /><path d="M11 3h6v6M17 3l-8 8" /></Svg>;
// a small rubber duck, outline version of the brand mark
export const DuckIcon = (p) => <Svg {...p}><path d="M3 12c0-2 2-3 4-3h1.5C7.5 8 7 6.8 7 5.6 7 3.6 8.6 2 10.6 2s3.6 1.6 3.6 3.6c0 .8-.2 1.4-.6 2 2 .3 3.9 1.4 3.9 4 0 3.2-3 5.4-7.3 5.4S3 15.2 3 12z" /><path d="M14.2 4.6c1.4-.3 2.6 0 3.3.8-.8.8-2 1-3.3.8" /></Svg>;
export const DotIcon = ({ size = 10, color = 'currentColor' }) => <svg className="ico" width={size} height={size} viewBox="0 0 10 10" aria-hidden><circle cx="5" cy="5" r="4" fill={color} /></svg>;
