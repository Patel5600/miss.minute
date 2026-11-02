/**
 * Development-only stand-in for the Android bridge so the dashboard layout can be checked in a
 * desktop browser (open dashboard.html?mock=1 on the Vite dev server). It is imported only when
 * import.meta.env.DEV is true, so it never reaches the production bundle. It answers `hello`
 * and nothing else; every other request fails with `unavailable`. Screenshots taken with it are
 * "web-only, not on device".
 */
import { decode, error, reply } from '../src/shared/protocol.ts';

const port = {
  onmessage: null as ((event: { data: unknown }) => void) | null,
  postMessage(text: string): void {
    const message = decode(text);
    const answer = message.type === 'hello'
      ? reply(message.id ?? '', { mock: true })
      : error(message.id ?? '', 'unavailable', 'mock bridge');
    window.setTimeout(() => port.onmessage?.({ data: answer }), 0);
  },
};

window.missNative = port;