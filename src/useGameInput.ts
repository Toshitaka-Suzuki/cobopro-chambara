import { useEffect } from 'react';
import type { GameAction, GameState, TargetId } from './game';
import { isGameFinished } from './game';
import type { InputMode } from './inputMode';

/** 画面単独・統合モードに共通のキーボード操作。 */
export function useGameInput(
  gameRef: { current: GameState }, inputMode: InputMode,
  sendAction: (action: GameAction) => void, receiveSword: () => void, onEscape: () => void,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (gameRef.current.paused || isGameFinished(gameRef.current.phase)) return;
      if (event.code === 'Space' && target instanceof HTMLElement && target.closest('button, a, summary')) return;
      if (event.code === 'Space' && inputMode === 'mock') {
        event.preventDefault();
        receiveSword();
      }
      if (event.code === 'KeyF') {
        event.preventDefault();
        sendAction({ type: 'miss' });
      }
      if (event.code === 'KeyB') {
        event.preventDefault();
        sendAction({ type: 'balloon' });
      }
      const digit = /^(?:Digit|Numpad)([123])$/.exec(event.code);
      if (digit && inputMode === 'mock') {
        event.preventDefault();
        sendAction({ type: 'hit', target: (Number(digit[1]) - 1) as TargetId });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gameRef, inputMode, sendAction, receiveSword, onEscape]);
}
