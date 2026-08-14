import React from 'react';

/**
 * Professional SVG device icons for the garage layout editor.
 * Each icon is a 16x16 viewBox SVG component that accepts className.
 */

export function FliCameraIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="2" y="4" width="9" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11 6.5L14 4.5V10.5L11 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function LprCameraIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="2" y="4" width="9" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11 6.5L14 4.5V10.5L11 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="4" y="6" width="5" height="3" rx="0.5" stroke="currentColor" strokeWidth="0.8" />
      <text x="6.5" y="8.8" textAnchor="middle" fill="currentColor" fontSize="3" fontWeight="bold" fontFamily="monospace">LP</text>
    </svg>
  );
}

export function PeopleCameraIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="2" y="4" width="9" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11 6.5L14 4.5V10.5L11 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="5.5" cy="7" r="0.8" stroke="currentColor" strokeWidth="0.7" />
      <path d="M4.5 9.5C4.5 8.5 5 8 5.5 8C6 8 6.5 8.5 6.5 9.5" stroke="currentColor" strokeWidth="0.7" />
      <circle cx="8" cy="7" r="0.8" stroke="currentColor" strokeWidth="0.7" />
      <path d="M7 9.5C7 8.5 7.5 8 8 8C8.5 8 9 8.5 9 9.5" stroke="currentColor" strokeWidth="0.7" />
    </svg>
  );
}

export function LedSignIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="2" y="3" width="12" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 12.5V10" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11 12.5V10" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 12.5H12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5" cy="6.5" r="0.6" fill="currentColor" />
      <circle cx="7" cy="6.5" r="0.6" fill="currentColor" />
      <circle cx="9" cy="6.5" r="0.6" fill="currentColor" />
      <circle cx="11" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function StaticSignIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="3" y="2" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 10V13.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 13.5H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 5H11" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
      <path d="M5 7H9" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  );
}

export function DesignableSignIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="2" y="3" width="12" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 12.5V10" stroke="currentColor" strokeWidth="1.3" />
      <path d="M11 12.5V10" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 12.5H12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 5L7 8H4L6 5.5" stroke="currentColor" strokeWidth="0.7" strokeLinejoin="round" />
      <rect x="8" y="5" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="0.7" />
    </svg>
  );
}

export function NwaveSensorIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="10" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 8C5 6.3 6.3 5 8 5C9.7 5 11 6.3 11 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M3 6.5C3 4 5.2 2 8 2C10.8 2 13 4 13 6.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="8" cy="10" r="0.7" fill="currentColor" />
    </svg>
  );
}

export function ParksolSensorIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <text x="8" y="10.5" textAnchor="middle" fill="currentColor" fontSize="7" fontWeight="bold" fontFamily="sans-serif">P</text>
    </svg>
  );
}

export function ProcoSensorIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <rect x="4" y="7" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 7V5C6 3.9 6.9 3 8 3C9.1 3 10 3.9 10 5V7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="9.5" r="0.7" fill="currentColor" />
      <path d="M8 10.2V11" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

export function EnsightSensorIcon({ className = 'w-4 h-4', ...props }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <path d="M8 3C4.5 3 2 6 1 8C2 10 4.5 13 8 13C11.5 13 14 10 15 8C14 6 11.5 3 8 3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="8" cy="8" r="0.8" fill="currentColor" />
    </svg>
  );
}

/**
 * Map device type ID to its icon component
 */
export const DEVICE_ICON_MAP = {
  'cam-fli': FliCameraIcon,
  'cam-lpr': LprCameraIcon,
  'cam-people': PeopleCameraIcon,
  'sign-led': LedSignIcon,
  'sign-static': StaticSignIcon,
  'sign-designable': DesignableSignIcon,
  'sensor-nwave': NwaveSensorIcon,
  'sensor-parksol': ParksolSensorIcon,
  'sensor-proco': ProcoSensorIcon,
  'sensor-ensight': EnsightSensorIcon,
};

/**
 * Get the icon component for a device type. Returns a fallback circle if unknown.
 */
export function DeviceIcon({ type, className = 'w-4 h-4', ...props }) {
  const Icon = DEVICE_ICON_MAP[type];
  if (Icon) return <Icon className={className} {...props} />;
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}
