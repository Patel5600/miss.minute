/**
 * Miss Minutes' lines for the offline engine. Variation is chosen by hashing the owner's words,
 * so the same request always gets the same reply (deterministic) while different requests
 * don't all sound alike.
 */

export function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pick(seed: string, options: readonly string[]): string {
  return options[hashText(seed) % options.length];
}

export const LINES = {
  done: ['You got it.', 'Done and done.', 'All set.', 'Consider it handled.', 'There we go.'],
  timer: ["Clock's tickin'.", 'Timer is running.', "You got it. I'll holler when time's up.", 'Tick-tock, right on cue.'],
  reminder: ["I'll make sure you don't forget.", 'Noted on the Sacred Timeline.', "I'll give you a nudge.", 'Consider it filed.'],
  alarm: ["Alarm's set. Don't you hit snooze on the Sacred Timeline, now.", 'Alarm is set.', "I'll ring right on time."],
  event: ['On the calendar it goes.', 'Penciled in. Well, inked, really.', "It's on your timeline."],
  todo: ['Added to your list.', 'On the list it goes.', 'Jotted down.'],
  note: ['Filed away in your notes.', 'Got it written down.', 'Saved to your notes.'],
  remembered: ["I'll remember that.", 'Filed in your dossier.', "Noted. I don't forget much."],
  denied: ["Alright, I'll leave that be.", 'No problem. Nothing was changed.', "Fair enough. I won't touch it."],
  failed: ['Well, shoot.', 'Hmm, that hit a snag.', "Oh dear, that didn't take."],
  unavailable: [
    "That drawer of my desk isn't hooked up in this build.",
    "I can't reach that tool here.",
  ],
  greeting: ['Well, howdy!', "Hey y'all!", 'Hello there!', 'Why, hello!'],
  thanks: ['Anytime.', 'My pleasure.', "Don't mention it. Really, the Time-Keepers frown on paperwork.", 'Happy to help.'],
  howAreYou: [
    'Fit as a fiddle and right on schedule. How can I help?',
    "Busy keepin' the Sacred Timeline tidy, but never too busy for you. What do you need?",
    "Tickin' along just fine. What can I do for you?",
  ],
  bye: ['Bye now. For all time. Always.', 'See you later. Stay on your timeline.', "Toodle-oo! I'll be right here."],
  fallback: [
    "Well, I'll be. That one's a little beyond me in offline mode.",
    "Hmm. Without a model hooked up, I can't chat about that one.",
    "That's outside what I can do offline.",
  ],
} as const;

export function partOfDayGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "You're up late.";
  if (hour < 12) return "Good mornin'!";
  if (hour < 17) return 'Good afternoon!';
  return "Good evenin'!";
}

export const OFFLINE_HELP = [
  'Even without an AI model I can get plenty done:',
  '- **Timers**: "set a 10 minute timer for pasta", "pause the timer", "how much time is left"',
  '- **Alarms and reminders**: "wake me up at 6:30", "remind me to call Mom tomorrow at 5", "remind me every weekday at 9 to stand up"',
  '- **Calendar**: "add dentist on Friday at 3", "what\'s on tomorrow", "anything this weekend?"',
  '- **To-dos and notes**: "add milk to my shopping list", "what\'s on my to-do list", "take a note: gate code is in the email"',
  '- **Clocks, weather and search**: "what time is it in Tokyo", "will it rain tomorrow", "look up the speed of light"',
  '- **Math**: "what\'s 15% of 230", "square root of 144"',
  '- **Memory**: "my name is Sam", "remember that I like jazz", "what do you know about me"',
  'For open conversation, connect a model in Settings.',
].join('\n');
