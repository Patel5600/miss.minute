/**
 * PC control through the desktop host (Tauri). Only available inside the desktop app.
 *
 * Read-only tools (list_apps, system_info) call desktop_run. Everything else is proposed with
 * desktop_propose: the host validates the arguments, resolves paths, stores the exact action
 * and returns the preview the owner approves. run() then calls desktop_approve(proposal id),
 * so the host executes the stored action, never arguments re-sent from here. Denials must call
 * desktop_reject so the stored proposal is discarded.
 */
import { invokeNative, isDesktopRuntime, type DesktopActionResult, type DesktopProposal } from '../../desktop/bridge';
import { logActivity } from '../../store/db';
import { ToolInputError, clip, errorMessage, optionalNumber, optionalText, requiredEnum, requiredText, type RawArgs } from './args';
import { makeTool } from './define';
import type { JsonSchema, ToolContext, ToolPreview, ToolResult } from './types';

const MAX_PATH = 1024;
/** Most results stay under the 4 KB guideline; file reads and command output may use more. */
const OUTPUT_LIMIT = 3500;
const LONG_OUTPUT_LIMIT = 12_000;

function desktopOnly(ctx: ToolContext): boolean {
  return ctx.desktop && isDesktopRuntime();
}

function checkPath(args: RawArgs, key: string): string {
  const path = requiredText(args, key, MAX_PATH, { raw: true }).trim();
  if (!path) throw new ToolInputError(`'${key}' is required.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) throw new ToolInputError(`'${key}' contains control characters.`);
  return path;
}

function toPreview(proposal: DesktopProposal): ToolPreview {
  if (!proposal || typeof proposal.id !== 'string' || typeof proposal.preview !== 'string') {
    throw new Error('The desktop app returned an invalid proposal.');
  }
  return {
    text: proposal.preview,
    content: proposal.contentPreview ?? undefined,
    risk: proposal.risk === 'high' || proposal.risk === 'medium' ? proposal.risk : 'low',
    token: proposal.id,
  };
}

function resultFrom(result: DesktopActionResult, limit: number): ToolResult {
  const output = typeof result.output === 'string' ? result.output : undefined;
  const truncated = output !== undefined && output.length > limit;
  return {
    ok: Boolean(result.ok),
    summary: clip(result.summary || (result.ok ? 'Done' : 'The desktop action failed'), 240),
    data: {
      ...(output !== undefined ? { output: truncated ? output.slice(0, limit) : output } : {}),
      ...(truncated ? { truncated: true, total_characters: output.length } : {}),
    },
  };
}

/** Discards one stored desktop proposal (DesktopProposal.id, which is ToolPreview.token). */
export async function rejectDesktopProposal(token: string): Promise<void> {
  if (!token || !isDesktopRuntime()) return;
  await invokeNative<void>('desktop_reject', { id: token });
}

/**
 * Call when the owner denies a confirm tool. Discards the host's stored desktop proposal (if the
 * preview came from the host) and records the denial in the activity log. Safe for any tool.
 */
export async function discardPreparedAction(toolName: string, prepared?: ToolPreview): Promise<void> {
  void logActivity('approval', clip(`Denied: ${prepared?.text ?? toolName}`, 240), { tool: toolName, approved: false }).catch(() => undefined);
  if (prepared?.token && DESKTOP_CONFIRM_TOOLS.has(toolName)) {
    try {
      await rejectDesktopProposal(prepared.token);
    } catch (error) {
      console.warn('[tools] desktop_reject failed:', errorMessage(error));
    }
  }
}

interface ConfirmSpec<P extends RawArgs> {
  name: string;
  description: string;
  properties: Record<string, JsonSchema>;
  required: string[];
  parse(args: RawArgs): P;
  describe(args: P): string;
  failure: string;
  longOutput?: boolean;
}

function confirmTool<P extends RawArgs>(spec: ConfirmSpec<P>) {
  return makeTool<P>({
    name: spec.name,
    description: `${spec.description} Desktop app only. The owner sees the exact action and must approve it.`,
    parameters: { type: 'object', properties: spec.properties, required: spec.required },
    policy: 'confirm',
    failure: spec.failure,
    available: desktopOnly,
    parse: spec.parse,
    describe: spec.describe,
    async prepare(args) {
      if (!isDesktopRuntime()) throw new Error('Desktop actions need the Miss Minutes desktop app.');
      return toPreview(await invokeNative<DesktopProposal>('desktop_propose', { tool: spec.name, args }));
    },
    async run(_args, _ctx, prepared) {
      if (!isDesktopRuntime()) throw new Error('Desktop actions need the Miss Minutes desktop app.');
      if (!prepared?.token) throw new Error('This action has no approved proposal; it must be previewed and approved first.');
      const result = await invokeNative<DesktopActionResult>('desktop_approve', { id: prepared.token });
      return resultFrom(result, spec.longOutput ? LONG_OUTPUT_LIMIT : OUTPUT_LIMIT);
    },
  });
}

const PATH_HINT = 'Absolute, "~\\...", or starting with Desktop, Documents, Downloads, Pictures, Music or Videos.';

function pathProperty(description: string): JsonSchema {
  return { type: 'string', description: `${description} ${PATH_HINT}` };
}

const WRITE_MODES = ['create', 'overwrite', 'append'] as const;

const confirmTools = [
  confirmTool<{ name: string }>({
    name: 'open_app',
    description: 'Opens an installed application by name (see list_apps).',
    properties: { name: { type: 'string', description: 'App name, e.g. "Notepad" or "Spotify".' } },
    required: ['name'],
    parse: args => ({ name: requiredText(args, 'name', 200) }),
    describe: args => `Open ${args.name}`,
    failure: "Couldn't open the app",
  }),
  confirmTool<{ url: string }>({
    name: 'open_url',
    description: 'Opens a web page in the default browser. http and https only.',
    properties: { url: { type: 'string', description: 'Full URL starting with http:// or https://.' } },
    required: ['url'],
    parse(args) {
      const url = requiredText(args, 'url', 2048);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ToolInputError(`"${clip(url, 80)}" is not a valid URL. Include https://.`);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ToolInputError('Only http and https links can be opened.');
      if (parsed.username || parsed.password) throw new ToolInputError('Links with embedded credentials are not allowed.');
      return { url: parsed.toString() };
    },
    describe: args => `Open ${args.url} in your browser`,
    failure: "Couldn't open the link",
  }),
  confirmTool<{ path: string }>({
    name: 'open_path',
    description: 'Opens a file or folder with its default app (folders open in Explorer).',
    properties: { path: pathProperty('File or folder.') },
    required: ['path'],
    parse: args => ({ path: checkPath(args, 'path') }),
    describe: args => `Open ${args.path}`,
    failure: "Couldn't open that",
  }),
  confirmTool<{ path: string }>({
    name: 'list_directory',
    description: 'Lists the files and folders inside a folder (names, sizes, dates).',
    properties: { path: pathProperty('Folder.') },
    required: ['path'],
    parse: args => ({ path: checkPath(args, 'path') }),
    describe: args => `List the contents of ${args.path}`,
    failure: "Couldn't list that folder",
    longOutput: true,
  }),
  confirmTool<{ path: string; max_bytes?: number }>({
    name: 'read_text_file',
    description: 'Reads a text file and returns its content (up to max_bytes, default chosen by the host).',
    properties: {
      path: pathProperty('Text file.'),
      max_bytes: { type: 'integer', minimum: 1, maximum: 1_048_576, description: 'Read at most this many bytes.' },
    },
    required: ['path'],
    parse: args => {
      const maxBytes = optionalNumber(args, 'max_bytes', { min: 1, max: 1_048_576, integer: true, unit: 'bytes' });
      return { path: checkPath(args, 'path'), ...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}) };
    },
    describe: args => `Read ${args.path}`,
    failure: "Couldn't read the file",
    longOutput: true,
  }),
  confirmTool<{ path: string; content: string; mode: (typeof WRITE_MODES)[number] }>({
    name: 'write_text_file',
    description: 'Writes text to a file. mode: create (fails if it exists), overwrite (replaces it) or append.',
    properties: {
      path: pathProperty('Target file.'),
      content: { type: 'string', description: 'Exact text to write.' },
      mode: { type: 'string', enum: [...WRITE_MODES], description: 'create, overwrite or append.' },
    },
    required: ['path', 'content', 'mode'],
    parse(args) {
      const content = args.content;
      if (typeof content !== 'string') throw new ToolInputError("'content' must be a string.");
      if (content.length > 1_000_000) throw new ToolInputError("'content' is too long (limit 1,000,000 characters).");
      return { path: checkPath(args, 'path'), content, mode: requiredEnum(args, 'mode', WRITE_MODES) };
    },
    describe: args => `${args.mode === 'append' ? 'Append' : args.mode === 'overwrite' ? 'Overwrite' : 'Create'} ${args.path} (${args.content.length} characters)`,
    failure: "Couldn't write the file",
  }),
  confirmTool<{ path: string }>({
    name: 'make_directory',
    description: 'Creates a folder (and missing parent folders).',
    properties: { path: pathProperty('Folder to create.') },
    required: ['path'],
    parse: args => ({ path: checkPath(args, 'path') }),
    describe: args => `Create the folder ${args.path}`,
    failure: "Couldn't create the folder",
  }),
  confirmTool<{ from: string; to: string }>({
    name: 'move_path',
    description: 'Moves or renames a file or folder.',
    properties: { from: pathProperty('Existing file or folder.'), to: pathProperty('New location or name.') },
    required: ['from', 'to'],
    parse: args => ({ from: checkPath(args, 'from'), to: checkPath(args, 'to') }),
    describe: args => `Move ${args.from} to ${args.to}`,
    failure: "Couldn't move that",
  }),
  confirmTool<{ from: string; to: string }>({
    name: 'copy_path',
    description: 'Copies a file or folder.',
    properties: { from: pathProperty('Existing file or folder.'), to: pathProperty('Destination.') },
    required: ['from', 'to'],
    parse: args => ({ from: checkPath(args, 'from'), to: checkPath(args, 'to') }),
    describe: args => `Copy ${args.from} to ${args.to}`,
    failure: "Couldn't copy that",
  }),
  confirmTool<{ path: string }>({
    name: 'delete_path',
    description: 'Moves a file or folder to the Recycle Bin (recoverable).',
    properties: { path: pathProperty('File or folder to delete.') },
    required: ['path'],
    parse: args => ({ path: checkPath(args, 'path') }),
    describe: args => `Move ${args.path} to the Recycle Bin`,
    failure: "Couldn't delete that",
  }),
  confirmTool<{ command: string; cwd?: string; timeout_seconds?: number }>({
    name: 'run_command',
    description: 'Runs one PowerShell command and returns its output. Prefer the specific file tools when they fit.',
    properties: {
      command: { type: 'string', description: 'The exact PowerShell command.' },
      cwd: pathProperty('Working folder (optional).'),
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Stop after this many seconds.' },
    },
    required: ['command'],
    parse(args) {
      const command = requiredText(args, 'command', 8000, { raw: true }).trim();
      if (!command) throw new ToolInputError("'command' is required.");
      const cwd = args.cwd === undefined ? undefined : checkPath(args, 'cwd');
      const timeout = optionalNumber(args, 'timeout_seconds', { min: 1, max: 600, integer: true, unit: 'seconds' });
      return { command, ...(cwd ? { cwd } : {}), ...(timeout !== undefined ? { timeout_seconds: timeout } : {}) };
    },
    describe: args => `Run in PowerShell: ${clip(args.command, 200)}`,
    failure: 'The command failed to run',
    longOutput: true,
  }),
];

const DESKTOP_CONFIRM_TOOLS = new Set(confirmTools.map(tool => tool.name));

async function runReadOnly(name: string, args: RawArgs): Promise<ToolResult> {
  if (!isDesktopRuntime()) throw new Error('This needs the Miss Minutes desktop app.');
  const result = await invokeNative<DesktopActionResult>('desktop_run', { tool: name, args });
  return resultFrom(result, OUTPUT_LIMIT);
}

export const desktopTools = [
  makeTool<{ query?: string }>({
    name: 'list_apps',
    description: 'Lists installed applications (optionally filtered by name) so you can open one with open_app. Desktop app only.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Part of an app name.' } } },
    policy: 'auto',
    failure: "Couldn't list apps",
    available: desktopOnly,
    parse: args => {
      const query = optionalText(args, 'query', 120);
      return query ? { query } : {};
    },
    describe: args => (args.query ? `List installed apps matching "${args.query}"` : 'List installed apps'),
    run: args => runReadOnly('list_apps', args),
  }),
  makeTool<Record<string, never>>({
    name: 'system_info',
    description: 'Reports the computer\'s OS, CPU, memory, disk space, battery and uptime. Desktop app only.',
    parameters: { type: 'object', properties: {} },
    policy: 'auto',
    failure: "Couldn't read system info",
    available: desktopOnly,
    parse: () => ({}),
    describe: () => 'Read system information',
    run: () => runReadOnly('system_info', {}),
  }),
  ...confirmTools,
];
