// TG 回合统计：解释供应商原始用量、合并重叠阶段并生成尾部；由同目录 index.ts 调用。
export type UsageEvidence = {
  rawUsage: any;
  protocol: string;
  responseMetadata?: Record<string, unknown>;
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function interpretUsage(evidence?: UsageEvidence) {
  const raw = evidence?.rawUsage;
  const responses = evidence?.protocol === "responses";
  const supported = responses || evidence?.protocol === "completions";
  const input = supported ? count(responses ? raw?.input_tokens : raw?.prompt_tokens) : null;
  const output = supported ? count(responses ? raw?.output_tokens : raw?.completion_tokens) : null;
  const details = responses ? raw?.input_tokens_details : raw?.prompt_tokens_details;
  const cacheRead = count(details?.cached_tokens ?? raw?.prompt_cache_hit_tokens);
  // OpenAI Responses/Completions do not define cache writes; absent extension field means no separate write bucket.
  // For compatible providers returning that bucket explicitly, subtract it too, following installed Pi mapping.
  const cacheWritePresent = details != null && Object.hasOwn(details, "cache_write_tokens");
  const cacheWrite = cacheWritePresent ? count(details.cache_write_tokens) : 0;
  const valid = input !== null && cacheRead !== null && cacheWrite !== null
    && cacheRead + cacheWrite <= input;
  return {
    inputTotal: input,
    uncachedInput: valid ? input - cacheRead - cacheWrite : null,
    output,
    cacheRead,
    cacheWrite,
    cacheWriteFieldPresent: cacheWritePresent,
    reasoning: count(responses
      ? raw?.output_tokens_details?.reasoning_tokens
      : raw?.completion_tokens_details?.reasoning_tokens),
    outputIncludesReasoning: supported,
    source: evidence ? "provider_raw_usage" : "unknown_missing_raw_usage",
  };
}

export type Span = {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: string;
  details?: Record<string, unknown>;
};

export function unionDuration(spans: Span[]): number {
  const intervals = spans.map(span => [span.startMs, span.endMs])
    .filter(([start, end]) => Number.isFinite(start) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let duration = 0;
  let right = -Infinity;
  for (const [start, end] of intervals) {
    duration += Math.max(0, end - Math.max(start, right));
    right = Math.max(right, end);
  }
  return duration;
}

export function summarizeStages(spans: Span[]) {
  const names = [...new Set(spans.map(span => span.name))];
  return Object.fromEntries(names.map(name => {
    const matching = spans.filter(span => span.name === name);
    return [name, {
      count: matching.length,
      occupiedMs: unionDuration(matching),
      summedMs: matching.reduce((sum, span) => sum + span.durationMs, 0),
    }];
  }));
}

export function summarizeCoverage(spans: Span[], bodyElapsedMs: number | null) {
  if (bodyElapsedMs === null) {
    return null;
  }
  const clipped = spans.map(span => ({
    ...span,
    startMs: Math.max(0, span.startMs),
    endMs: Math.min(bodyElapsedMs, span.endMs),
  })).filter(span => span.endMs >= span.startMs);
  const observedMs = unionDuration(clipped);
  return {
    bodyLocalElapsedMs: bodyElapsedMs,
    observedUnionMs: observedMs,
    unattributedMs: Math.max(0, bodyElapsedMs - observedMs),
  };
}

function sumKnown(values: Array<number | null>): number | null {
  return values.length > 0 && values.every(value => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

export function summarizeUsage(requests: Array<{ usage?: ReturnType<typeof interpretUsage> }>) {
  return {
    requests: requests.length,
    uncachedInput: sumKnown(requests.map(request => request.usage?.uncachedInput ?? null)),
    output: sumKnown(requests.map(request => request.usage?.output ?? null)),
    cacheRead: sumKnown(requests.map(request => request.usage?.cacheRead ?? null)),
    scope: "all main-model requests in this Telegram turn; excludes memory and compaction model calls",
  };
}

export function formatTokenCount(value: number | null) {
  if (value === null) {
    return "?";
  }
  if (value >= 1000000 && value % 1000000 === 0) {
    return `${value / 1000000}M`;
  }
  return value >= 1000
    ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
    : String(value);
}

export function formatFooter(summary: {
  elapsedMs: number | null;
  usage: ReturnType<typeof summarizeUsage>;
  context: { tokens: number | null; window: number | null };
  model: string;
  thinking: string;
  tools: number | null;
}) {
  const time = summary.elapsedMs === null ? "?" : `${(summary.elapsedMs / 1000).toFixed(1)}s`;
  const tokens = summary.context.tokens;
  const window = summary.context.window;
  const context = tokens !== null && window !== null && window > 0
    ? `${(tokens / window * 100).toFixed(1)}% / ${formatTokenCount(window)}`
    : `? / ${formatTokenCount(window)}`;
  // Display uses k units or exact whole millions; exact integer counts remain in the session JSONL.
  return `────\n⏱ ${time} · tokens ↑${formatTokenCount(summary.usage.uncachedInput)} ↓${formatTokenCount(summary.usage.output)}`
    + ` · ${summary.model} · thinking ${summary.thinking} · ctx ${context} · tools ${summary.tools ?? "?"}`;
}
