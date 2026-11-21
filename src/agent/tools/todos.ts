/**
 * To-do list: add_todo, list_todos, complete_todo, delete_todo, plus domain functions for the
 * Toolbelt panel. A date-only due is stored as the last millisecond of that day.
 */
import { deleteRecord, getRecord, listAll, newId, putRecord, type TodoRecord } from '../../store/db';
import { ToolInputError, clip, optionalBoolean, optionalEnum, optionalText, requiredText } from './args';
import { makeTool } from './define';
import { findRecord } from './lookup';
import { dueIso, endOfDayMs, formatDue, parseDateTime, type ParsedDateTime } from './time';

export type Priority = TodoRecord['priority'];
export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high'];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const MAX_TEXT = 300;

export function checkTodoText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new ToolInputError('A to-do needs some text.');
  if (clean.length > MAX_TEXT) throw new ToolInputError(`The to-do is too long (limit ${MAX_TEXT} characters).`);
  return clean;
}

export function dueFromParsed(parsed: ParsedDateTime): number {
  return parsed.dateOnly ? endOfDayMs(parsed.ms) : parsed.ms;
}

/** Open first, then priority, then soonest due, then newest. */
export function sortTodos(todos: TodoRecord[]): TodoRecord[] {
  return [...todos].sort((a, b) =>
    Number(a.done) - Number(b.done)
    || (a.done && b.done ? (b.completedAt ?? 0) - (a.completedAt ?? 0) : 0)
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
    || b.createdAt - a.createdAt);
}

export async function createTodo(input: { text: string; priority?: Priority; dueAt?: number }): Promise<{ todo: TodoRecord; existing: boolean }> {
  const text = checkTodoText(input.text);
  const open = (await listAll('todos')).filter(todo => !todo.done);
  const duplicate = open.find(todo => todo.text.toLowerCase() === text.toLowerCase());
  if (duplicate) return { todo: duplicate, existing: true };
  const todo: TodoRecord = {
    id: newId(), text, done: false, priority: input.priority ?? 'normal', dueAt: input.dueAt, createdAt: Date.now(),
  };
  await putRecord('todos', todo);
  return { todo, existing: false };
}

async function loadTodo(id: string): Promise<TodoRecord> {
  const todo = await getRecord('todos', id);
  if (!todo) throw new ToolInputError('That to-do no longer exists.');
  return todo;
}

export async function setTodoDone(id: string, done: boolean): Promise<TodoRecord> {
  const todo = await loadTodo(id);
  return putRecord('todos', { ...todo, done, completedAt: done ? Date.now() : undefined });
}

export async function updateTodo(id: string, patch: { text?: string; priority?: Priority; dueAt?: number | null }): Promise<TodoRecord> {
  const todo = await loadTodo(id);
  const next: TodoRecord = { ...todo };
  if (patch.text !== undefined) next.text = checkTodoText(patch.text);
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.dueAt !== undefined) next.dueAt = patch.dueAt === null ? undefined : patch.dueAt;
  return putRecord('todos', next);
}

export async function deleteTodo(id: string): Promise<void> {
  await deleteRecord('todos', id);
}

function todoView(todo: TodoRecord, now: number) {
  return {
    id: todo.id,
    text: clip(todo.text, 160),
    priority: todo.priority,
    ...(todo.dueAt !== undefined ? { due: dueIso(todo.dueAt) } : {}),
    ...(todo.done ? { done: true } : {}),
    ...(!todo.done && todo.dueAt !== undefined && todo.dueAt < now ? { overdue: true } : {}),
  };
}

interface AddArgs { text: string; priority: Priority; due?: ParsedDateTime }
interface CompleteArgs { id?: string; text?: string }

export const todoTools = [
  makeTool<AddArgs>({
    name: 'add_todo',
    description:
      "Adds an item to the owner's to-do list. priority: low, normal (default) or high. due is optional: a date "
      + '("2026-11-02", meaning by the end of that day) or an ISO 8601 local date-time. Adding the same open item twice '
      + 'returns the existing one.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The task, e.g. "Renew passport".' },
        priority: { type: 'string', enum: [...PRIORITIES], description: 'Default normal.' },
        due: { type: 'string', description: 'Optional due date or date-time (ISO 8601 local).' },
      },
      required: ['text'],
    },
    policy: 'auto',
    failure: "Couldn't add the to-do",
    parse(args) {
      const due = args.due === undefined || args.due === '' ? undefined : parseDateTime(args.due, 'due');
      return { text: requiredText(args, 'text', MAX_TEXT), priority: optionalEnum(args, 'priority', PRIORITIES) ?? 'normal', due };
    },
    describe(args) {
      return `Add to-do "${args.text}"${args.priority !== 'normal' ? ` (${args.priority})` : ''}${args.due ? `, due ${formatDue(dueFromParsed(args.due))}` : ''}`;
    },
    async run(args) {
      const now = Date.now();
      const dueAt = args.due ? dueFromParsed(args.due) : undefined;
      const { todo, existing } = await createTodo({ text: args.text, priority: args.priority, dueAt });
      const extras = [todo.priority !== 'normal' ? todo.priority : '', todo.dueAt !== undefined ? `due ${formatDue(todo.dueAt, now)}` : '']
        .filter(Boolean).join(', ');
      const late = !existing && todo.dueAt !== undefined && todo.dueAt < now ? ' (already overdue)' : '';
      const summary = existing
        ? `"${todo.text}" is already on the list`
        : `Added to-do: "${todo.text}"${extras ? ` (${extras})` : ''}${late}`;
      return { ok: true, summary, data: { ...todoView(todo, now), ...(existing ? { already_existed: true } : {}) } };
    },
  }),

  makeTool<{ includeDone: boolean }>({
    name: 'list_todos',
    description: 'Lists open to-dos (high priority and soonest due first). include_done=true adds recently completed ones.',
    parameters: {
      type: 'object',
      properties: { include_done: { type: 'boolean', description: 'Also list completed items. Default false.' } },
    },
    policy: 'auto',
    failure: "Couldn't list to-dos",
    parse(args) {
      return { includeDone: optionalBoolean(args, 'include_done') ?? false };
    },
    describe(args) {
      return args.includeDone ? 'List all to-dos' : 'List open to-dos';
    },
    async run(args) {
      const now = Date.now();
      const all = sortTodos(await listAll('todos'));
      const open = all.filter(todo => !todo.done);
      const shown = (args.includeDone ? [...open, ...all.filter(todo => todo.done).slice(0, 15)] : open).slice(0, 50);
      const high = open.filter(todo => todo.priority === 'high').length;
      const overdue = open.filter(todo => todo.dueAt !== undefined && todo.dueAt < now).length;
      const detail = [high ? `${high} high` : '', overdue ? `${overdue} overdue` : ''].filter(Boolean).join(', ');
      const summary = open.length === 0 ? 'No open to-dos' : `${open.length} open to-do${open.length === 1 ? '' : 's'}${detail ? ` (${detail})` : ''}`;
      return {
        ok: true,
        summary,
        data: { open: open.length, todos: shown.map(todo => todoView(todo, now)), ...(open.length > 50 ? { truncated: open.length - 50 } : {}) },
      };
    },
  }),

  makeTool<CompleteArgs>({
    name: 'complete_todo',
    description:
      'Marks a to-do done. Pass id (from list_todos) or text; text matches an open item exactly or, failing that, '
      + 'the one open item containing it. Several matches return an error listing them.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'To-do id.' },
        text: { type: 'string', description: 'To-do text (or a distinctive part of it), if no id.' },
      },
    },
    policy: 'auto',
    failure: "Couldn't complete the to-do",
    parse(args) {
      const id = optionalText(args, 'id', 80);
      const text = optionalText(args, 'text', MAX_TEXT);
      if (!id && !text) throw new ToolInputError("Pass 'id' or 'text'.");
      return { id, text };
    },
    describe(args) {
      return `Mark to-do ${args.id ? args.id : `"${args.text}"`} done`;
    },
    async run(args) {
      let todo: TodoRecord;
      if (args.id) {
        todo = await findRecord('todos', args.id, { noun: 'to-do', listTool: 'list_todos', nameOf: item => item.text });
      } else {
        const wanted = (args.text ?? '').toLowerCase();
        const open = (await listAll('todos')).filter(item => !item.done);
        const exact = open.filter(item => item.text.toLowerCase() === wanted);
        const loose = exact.length > 0 ? exact : open.filter(item => item.text.toLowerCase().includes(wanted));
        if (loose.length === 0) throw new ToolInputError(`No open to-do matches "${args.text}". Call list_todos to see them.`);
        if (loose.length > 1) {
          throw new ToolInputError(`Several open to-dos match "${args.text}": ${loose.slice(0, 5).map(item => `${item.id} ("${item.text}")`).join(', ')}. Pass the id.`);
        }
        todo = loose[0];
      }
      if (todo.done) return { ok: true, summary: `"${todo.text}" was already done`, data: todoView(todo, Date.now()) };
      const updated = await setTodoDone(todo.id, true);
      const left = (await listAll('todos')).filter(item => !item.done).length;
      return { ok: true, summary: `Done: "${updated.text}" (${left} left)`, data: { ...todoView(updated, Date.now()), open_left: left } };
    },
  }),

  makeTool<{ id: string }>({
    name: 'delete_todo',
    description: 'Deletes a to-do by id (use complete_todo for finished work). Asks the owner first.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'To-do id from list_todos.' } },
      required: ['id'],
    },
    policy: 'confirm',
    failure: "Couldn't delete the to-do",
    parse(args) {
      return { id: requiredText(args, 'id', 80) };
    },
    describe(args) {
      return `Delete to-do ${args.id}`;
    },
    async prepare(args) {
      const todo = await findRecord('todos', args.id, { noun: 'to-do', listTool: 'list_todos', nameOf: item => item.text });
      const state = todo.done ? 'completed' : `open, ${todo.priority} priority${todo.dueAt !== undefined ? `, due ${formatDue(todo.dueAt)}` : ''}`;
      return { text: `Delete the to-do "${todo.text}" (${state}).`, risk: 'low', token: todo.id };
    },
    async run(args, _ctx, prepared) {
      const id = prepared?.token ?? (await findRecord('todos', args.id, { noun: 'to-do', listTool: 'list_todos', nameOf: item => item.text })).id;
      const todo = await getRecord('todos', id);
      if (!todo) return { ok: true, summary: 'That to-do was already gone', data: { id, deleted: false } };
      await deleteTodo(id);
      return { ok: true, summary: `Deleted to-do "${todo.text}"`, data: { id, deleted: true } };
    },
  }),
];
