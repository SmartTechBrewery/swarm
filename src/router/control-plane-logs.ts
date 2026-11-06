/**
 * How many recent log lines the control plane keeps in memory for the operator
 * MCP server's `control_plane_logs` tool (issue #1343). A constant rather than a
 * setting: the buffer is a window onto recent activity, not a log store, and at a
 * few hundred bytes a line this bounds it to single-digit megabytes. Shared by the
 * router and the all-in-one control plane, the two processes serving `/operator/mcp`.
 */
export const CONTROL_PLANE_LOG_BUFFER_CAPACITY = 20_000;
