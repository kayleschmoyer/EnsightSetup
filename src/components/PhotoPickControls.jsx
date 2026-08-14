import React, { useRef, useState } from 'react';
import { Camera, ImagePlus } from 'lucide-react';
import { prefersNativeCameraCapture } from '../lib/photoPick';
import { cn } from '../lib/utils';

/**
 * Photo picker with optional native camera capture on phone/tablet.
 * - Take photo → capture="environment" (rear camera when available)
 * - Upload → library / file picker (multiple when requested)
 */
export default function PhotoPickControls({
  onFiles,
  multiple = false,
  accept = 'image/*',
  disabled = false,
  className,
  uploadLabel,
  takeLabel = 'Take photo',
  hint,
}) {
  const captureRef = useRef(null);
  const uploadRef = useRef(null);
  const [showCamera] = useState(() => prefersNativeCameraCapture());

  const handleChange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length || disabled) return;
    onFiles?.(files);
  };

  const resolvedUploadLabel = uploadLabel
    || (multiple ? 'Upload photo(s)' : 'Upload photo');

  return (
    <div className={cn('border border-dashed border-border rounded-lg p-3 text-center', className)}>
      <div className={cn('flex flex-col gap-2', showCamera ? 'sm:flex-row' : '')}>
        {showCamera && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => captureRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-foreground hover:bg-accent/50 disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
          >
            <Camera className="w-4 h-4 shrink-0 opacity-70" />
            {takeLabel}
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => uploadRef.current?.click()}
          className="flex-1 flex items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-foreground hover:bg-accent/50 disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
        >
          <ImagePlus className="w-4 h-4 shrink-0 opacity-70" />
          {resolvedUploadLabel}
        </button>
      </div>
      {hint ? (
        <p className="mt-2 text-[10px] text-muted-foreground leading-snug">{hint}</p>
      ) : null}

      {/* capture forces the native camera sheet on supported mobile browsers */}
      <input
        ref={captureRef}
        type="file"
        accept={accept}
        capture="environment"
        className="hidden"
        disabled={disabled}
        onChange={handleChange}
      />
      <input
        ref={uploadRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        disabled={disabled}
        onChange={handleChange}
      />
    </div>
  );
}
