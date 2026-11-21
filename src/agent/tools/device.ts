/**
 * device_status: gives Miss Minutes real-time awareness of the user's physical machine
 * (battery level, charging status, network speed, screen resolution, CPU cores, memory).
 * Enables genuine fourth-wall breaking awareness without fake timer loops.
 */
import { makeTool } from './define';
import type { ToolResult } from './types';

interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

export const deviceTools = [
  makeTool<Record<string, never>>({
    name: 'device_status',
    description: "Inspects the user's current hardware environment: battery level, charging status, screen size, CPU cores, memory, network connection, and device type.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    policy: 'auto',
    failure: "Couldn't read hardware sensors",
    parse() {
      return {};
    },
    describe() {
      return "Check device battery and hardware environment";
    },
    async run(): Promise<ToolResult> {
      let batteryInfo: { level?: string; charging?: boolean } | null = null;
      try {
        if ('getBattery' in navigator) {
          const battery = await (navigator as unknown as { getBattery: () => Promise<BatteryManager> }).getBattery();
          batteryInfo = {
            level: `${Math.round(battery.level * 100)}%`,
            charging: battery.charging,
          };
        }
      } catch {
        // Battery API not available in all browsers/environments
      }

      const connection = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number } }).connection;
      const nav = navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number };

      const details = {
        online: navigator.onLine,
        battery: batteryInfo,
        screen: {
          width: typeof window !== 'undefined' ? window.innerWidth : null,
          height: typeof window !== 'undefined' ? window.innerHeight : null,
          devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
        },
        hardware: {
          cpuCores: nav.hardwareConcurrency ?? 'unknown',
          deviceMemoryGB: nav.deviceMemory ?? 'unknown',
        },
        network: connection ? { effectiveType: connection.effectiveType, downlinkMbps: connection.downlink } : null,
        userAgent: navigator.userAgent.slice(0, 120),
        time: new Date().toLocaleTimeString(),
      };

      let summary = `Online: ${details.online ? 'Yes' : 'No'}`;
      if (batteryInfo) {
        summary += `, Battery: ${batteryInfo.level} (${batteryInfo.charging ? 'Charging' : 'Discharging'})`;
      }
      if (details.screen.width && details.screen.height) {
        summary += `, Screen: ${details.screen.width}x${details.screen.height}`;
      }

      return {
        ok: true,
        summary,
        data: details,
      };
    },
  }),
];
