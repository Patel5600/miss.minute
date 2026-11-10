/**
 * Notes: create_note, list_notes, read_note, append_note, delete_note, and the domain
 * functions behind the Toolbelt's note editor.
 */
import { deleteRecord, getRecord, listAll, newId, putRecord, type NoteRecord } from '../../store/db';
import { ToolInputError, clip, optionalText, requiredText } from './args';
import { makeTool } from './define';
import { findRecord } from './lookup';
import { formatWhen, localIso } from './time';

export const MAX_NOTE_TITLE = 200;
export const MAX_NOTE_BODY = 50_000;
const READ_LIMIT = 6000;

export function checkNoteTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!clean) throw new ToolInputError('A note needs a title.');
  if (clean.length > MAX_NOTE_TITLE) throw new ToolInputError(`The title is too long (limit ${MAX_NOTE_TITLE} characters).`);
  return clean;
}

function checkBody(body: string): string {
  const clean = body.replace(/\r\n?/g, '\n');
  if (clean.length > MAX_NOTE_BODY) throw new ToolInputError(`The note is too long (limit ${MAX_NOTE_BODY} characters).`);
  return clean;
}

export async function createNote(title: string, body: string): Promise<NoteRecord> {
  const now = Date.now();
  const note: NoteRecord = { id: newId(), title: checkNoteTitle(title), body: checkBody(body), createdAt: now, updatedAt: now };
  return putRecord('notes', note);
}

export async function updateNote(id: string, patch: { title?: string; body?: string }): Promise<NoteRecord> {
  const note = await getRecord('notes', id);
  if (!note) throw new ToolInputError('That note no longer exists.');
  return putRecord('notes', {
    ...note,
    title: patch.title !== undefined ? checkNoteTitle(patch.title) : note.title,
    body: patch.body !== undefined ? checkBody(patch.body) : note.body,
    updatedAt: Date.now(),
  });
}

export async function appendToNote(id: string, text: string): Promise<NoteRecord> {
  const note = await getRecord('notes', id);
  if (!note) throw new ToolInputError('That note no longer exists.');
  const addition = checkBody(text).trim();
  if (!addition) throw new ToolInputError('Nothing to append.');
  const body = note.body.trimEnd() ? `${note.body.trimEnd()}\n${addition}` : addition;
  return putRecord('notes', { ...note, body: checkBody(body), updatedAt: Date.now() });
}

export async function deleteNote(id: string): Promise<void> {
  await deleteRecord('notes', id);
}

/** Notes matching every word of the query in title or body, newest first. */
export function searchNotes(notes: NoteRecord[], query: string): NoteRecord[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return notes
    .filter(note => {
      const haystack = `${note.title}\n${note.body}`.toLowerCase();
      return words.every(word => haystack.includes(word));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function findNote(id: string): Promise<NoteRecord> {
  return findRecord('notes', id, { noun: 'note', listTool: 'list_notes', nameOf: note => note.title });
}

function preview(body: string): string {
  return clip(body.replace(/\s+/g, ' ').trim(), 120);
}

export const noteTools = [
  makeTool<{ title: string; body: string }>({
    name: 'create_note',
    description: 'Saves a new note (plain text or Markdown) on this device. Returns its id for read_note / append_note.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title.' },
        body: { type: 'string', description: 'Note content. Line breaks are kept.' },
      },
      required: ['title', 'body'],
    },
    policy: 'auto',
    failure: "Couldn't save the note",
    parse(args) {
      return {
        title: requiredText(args, 'title', MAX_NOTE_TITLE),
        body: optionalText(args, 'body', MAX_NOTE_BODY, { multiline: true }) ?? '',
      };
    },
    describe(args) {
      return `Save note "${args.title}" (${args.body.length} characters)`;
    },
    async run(args) {
      const note = await createNote(args.title, args.body);
      return {
        ok: true,
        summary: `Saved note "${note.title}"`,
        data: { id: note.id, title: note.title, characters: note.body.length },
      };
    },
  }),

  makeTool<{ query?: string }>({
    name: 'list_notes',
    description: 'Lists notes, newest first, with a short preview. query filters to notes containing every word.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to search for in titles and bodies.' } },
    },
    policy: 'auto',
    failure: "Couldn't list notes",
    parse(args) {
      return { query: optionalText(args, 'query', 200) };
    },
    describe(args) {
      return args.query ? `Search notes for "${args.query}"` : 'List notes';
    },
    async run(args) {
      const all = await listAll('notes');
      const notes = args.query ? searchNotes(all, args.query) : all.sort((a, b) => b.updatedAt - a.updatedAt);
      const shown = notes.slice(0, 30);
      const summary = args.query
        ? `${notes.length} note${notes.length === 1 ? '' : 's'} match "${args.query}"`
        : `${notes.length} note${notes.length === 1 ? '' : 's'}`;
      return {
        ok: true,
        summary,
        data: {
          notes: shown.map(note => ({ id: note.id, title: note.title, updated: localIso(note.updatedAt), preview: preview(note.body) })),
          ...(notes.length > shown.length ? { truncated: notes.length - shown.length } : {}),
        },
      };
    },
  }),

  makeTool<{ id: string }>({
    name: 'read_note',
    description: `Returns a note's full text by id (or exact title). Very long notes are cut at ${READ_LIMIT} characters.`,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id from list_notes.' } },
      required: ['id'],
    },
    policy: 'auto',
    failure: "Couldn't read the note",
    parse(args) {
      return { id: requiredText(args, 'id', 200) };
    },
    describe(args) {
      return `Read note ${args.id}`;
    },
    async run(args) {
      const note = await findNote(args.id);
      const truncated = note.body.length > READ_LIMIT;
      return {
        ok: true,
        summary: `Read "${note.title}" (${note.body.length} characters)`,
        data: {
          id: note.id,
          title: note.title,
          updated: localIso(note.updatedAt),
          body: truncated ? note.body.slice(0, READ_LIMIT) : note.body,
          ...(truncated ? { truncated: true, total_characters: note.body.length } : {}),
        },
      };
    },
  }),

  makeTool<{ id: string; text: string }>({
    name: 'append_note',
    description: 'Adds text to the end of an existing note (on a new line), e.g. to grow a shopping list.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id from list_notes.' },
        text: { type: 'string', description: 'Text to add.' },
      },
      required: ['id', 'text'],
    },
    policy: 'auto',
    failure: "Couldn't update the note",
    parse(args) {
      return { id: requiredText(args, 'id', 200), text: requiredText(args, 'text', MAX_NOTE_BODY, { multiline: true }) };
    },
    describe(args) {
      return `Append ${args.text.length} characters to note ${args.id}`;
    },
    async run(args) {
      const target = await findNote(args.id);
      const note = await appendToNote(target.id, args.text);
      return {
        ok: true,
        summary: `Added to "${note.title}"`,
        data: { id: note.id, title: note.title, characters: note.body.length },
      };
    },
  }),

  makeTool<{ id: string }>({
    name: 'delete_note',
    description: 'Deletes a note by id. Asks the owner first.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id from list_notes.' } },
      required: ['id'],
    },
    policy: 'confirm',
    failure: "Couldn't delete the note",
    parse(args) {
      return { id: requiredText(args, 'id', 200) };
    },
    describe(args) {
      return `Delete note ${args.id}`;
    },
    async prepare(args) {
      const note = await findNote(args.id);
      return {
        text: `Delete the note "${note.title}" (${note.body.length} characters, last edited ${formatWhen(note.updatedAt)}).`,
        risk: 'medium',
        token: note.id,
      };
    },
    async run(args, _ctx, prepared) {
      const id = prepared?.token ?? (await findNote(args.id)).id;
      const note = await getRecord('notes', id);
      if (!note) return { ok: true, summary: 'That note was already gone', data: { id, deleted: false } };
      await deleteNote(id);
      return { ok: true, summary: `Deleted note "${note.title}"`, data: { id, deleted: true } };
    },
  }),
];
