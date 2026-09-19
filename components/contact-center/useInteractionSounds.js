"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { createNotificationSoundPlayer } from '@/lib/contact-center/notification-sound-player.mjs';

export function useInteractionSounds(interactions, settings, available = true) {
  const player = useRef(null), [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const instance = createNotificationSoundPlayer({ onBlocked: setBlocked });
    player.current = instance;
    const unlock = () => instance.unlock();
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      instance.dispose(); player.current = null;
    };
  }, []);
  useEffect(() => { player.current?.update(available ? interactions : [], settings); }, [interactions, settings, available]);
  const enableSound = useCallback(() => player.current?.unlock(), []);
  return { soundBlocked: blocked, enableSound };
}
