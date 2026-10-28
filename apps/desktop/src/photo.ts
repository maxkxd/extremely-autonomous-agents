import { useEffect, useState } from 'react';

// Your profile photo (Settings > Account). Kept in this browser for now,
// shrunk to a small square so it fits easily.
const KEY = 'eaa.photo';
const EVENT = 'eaa-photo';
const SIZE = 160;
export const MAX_BYTES = 10 * 1024 * 1024;
export const ACCEPT = 'image/png,image/jpeg,image/webp';

export function getPhoto(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function store(dataUrl: string | null) {
  try {
    if (dataUrl) localStorage.setItem(KEY, dataUrl);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable - it lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: dataUrl }));
}

export const removePhoto = () => store(null);

// Crop to the centre square and scale down. Throws a readable error.
export async function setPhoto(file: File) {
  if (!ACCEPT.split(',').includes(file.type)) throw new Error('Use a PNG, JPEG or WebP image.');
  if (file.size > MAX_BYTES) throw new Error('That image is over 10MB.');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  store(canvas.toDataURL('image/webp', 0.85));
}

// The current photo, updating everywhere when it changes.
export function usePhoto() {
  const [photo, setState] = useState(getPhoto);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<string | null>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return photo;
}
