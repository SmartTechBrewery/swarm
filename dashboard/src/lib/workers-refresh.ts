/**
 * Poll cadence for the worker read models, matching the dashboard's idle
 * baseline (`runs-refresh.ts`). Comfortably below the default 60s heartbeat TTL,
 * so a worker that stops heartbeating flips to Offline within one poll without a
 * websocket. Shared by the `/workers` screen, the worker detail route, the
 * project detail page's Workers tab (issue #574), and the profile's My Workers
 * tab (issue #660), so all four age a machine out at the same rate.
 */
export const WORKERS_REFETCH_MS = 5_000;
