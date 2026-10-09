export function claudeSse(
  graph: unknown,
  options?: { stopReason?: string; fallback?: boolean; error?: string; cutAfter?: number; chunk?: number },
): string;
export const SSE_HEADERS: Record<string, string>;
