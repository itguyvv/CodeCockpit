// Minimal inline glyphs for the Remote access tab — monochrome, currentColor,
// matching the app's restrained icon language. Drawn here to avoid pulling an
// icon dependency for four shapes.

interface IconProps {
  className?: string
}

export function WifiIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className={className}>
      <path d="M3.5 9.5a13 13 0 0 1 17 0" />
      <path d="M6.5 13a9 9 0 0 1 11 0" />
      <path d="M9.5 16.4a5 5 0 0 1 5 0" />
      <circle cx="12" cy="19.3" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function GlobeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.8" ry="8.5" />
      <path d="M4 12h16" />
    </svg>
  )
}

export function PhoneIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className={className}>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M10.5 17.6h3" />
    </svg>
  )
}

export function AndroidIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M12 6.2c-3.4 0-6.1 2.6-6.1 6v6.6h12.2v-6.6c0-3.4-2.7-6-6.1-6zm-2.6 4.1a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1zm5.2 0a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1z"
      />
      <path d="M6.2 4.3a.6.6 0 0 1 .82-.2l2.4 1.5a.6.6 0 1 1-.62 1.02L6.4 5.12a.6.6 0 0 1-.2-.82zm11.6 0a.6.6 0 0 0-.82-.2l-2.4 1.5a.6.6 0 1 0 .62 1.02l2.4-1.5a.6.6 0 0 0 .2-.82z" />
    </svg>
  )
}
