/**
 * In-window cue bus: anything (brain, voice, tools, UI) can ask the character to emote or
 * gesture without importing the character component. The desktop overlay receives the same
 * cues through the host's speak events.
 */
import type { CharacterCue } from '../types';

type CueHandler = (cue: CharacterCue) => void;
const handlers = new Set<CueHandler>();

export function emitCue(cue: CharacterCue): void {
  handlers.forEach(handler => handler(cue));
}

export function onCue(handler: CueHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}
