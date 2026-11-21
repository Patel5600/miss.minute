/**
 * One-second heartbeat for the scheduler. Timers inside a dedicated worker are not subject to
 * the intensive throttling browsers apply to hidden tabs, so alarms in a background tab ring on
 * time instead of up to a minute late.
 */
setInterval(() => postMessage(Date.now()), 1000);
