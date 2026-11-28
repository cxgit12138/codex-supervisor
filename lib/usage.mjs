import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
export function localDay(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
function empty() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    cacheInput: 0, cacheSamples: 0, reasoningSamples: 0, partial: 0 };
}

function add(bucket, counts) {
  for (const key of Object.keys(bucket)) bucket[key] += counts[key] ?? 0;
}

// 每个文件只含一个监管线程。旧版只在回合完成时记录累计值。
export async function readUsage(file) {
  const days = {};
  const snapshots = new Set();
  let previous, lastTotal, freshThread = false;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"tokenUsage"') && !line.includes('"thread_meta"')) continue;
    if (!line.endsWith("}")) continue; // 另一个进程可能正在写最后一行。
    let row;
    try { row = JSON.parse(line); }
    catch (err) {
      if (err instanceof SyntaxError) continue; // 写入中的末行也可能恰好以嵌套对象的右括号结尾。
      throw err;
    }
    if (row.kind === "thread_meta") {
      previous = undefined;
      freshThread = row.action === "start";
      continue;
    }
    const live = row.kind === "token_usage";
    const usage = live ? row.tokenUsage : row.data?.tokenUsage?.tokenUsage;
    if (!usage?.total) continue;
    const total = usage.total;
    const signature = (row.turnId || row.data?.tokenUsage?.turnId || "") + "/" + total.totalTokens;
    if (snapshots.has(signature)) continue;
    snapshots.add(signature);
    if (lastTotal === total.totalTokens) continue;
    let delta;
    const partial = !live && !freshThread && (!previous || total.totalTokens < previous.totalTokens);
    if (live) delta = usage.last;
    else if (previous && total.totalTokens > previous.totalTokens) {
      delta = Object.fromEntries(fields.filter(k => total[k] != null && previous[k] != null).map(k => [k, Math.max(0, total[k] - previous[k])]));
    } else delta = freshThread ? total : usage.last;
    previous = total;
    lastTotal = total.totalTokens;
    freshThread = false;
    if (!delta || !delta.totalTokens) continue;
    const key = localDay(new Date(row.ts));
    add(days[key] ??= empty(), { ...delta, cacheInput: delta.cachedInputTokens == null ? 0 : delta.inputTokens,
      cacheSamples: Number(delta.cachedInputTokens != null), reasoningSamples: Number(delta.reasoningOutputTokens != null), partial: Number(partial) });
  }
  return days;
}

export function usageReader(logDir) {
  const cache = new Map();
  return async (now = new Date()) => {
    const days = {};
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith(".jsonl")) : [];
    for (const file of files) {
      const full = path.join(logDir, file);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      const stamp = stat.mtimeMs + "/" + stat.size;
      if (cache.get(file)?.stamp !== stamp) {
        try { cache.set(file, { stamp, days: await readUsage(full) }); }
        catch (err) { if (err.code === "ENOENT") continue; throw err; }
      }
      for (const [day, values] of Object.entries(cache.get(file).days)) add(days[day] ??= empty(), values);
    }
    for (const key of cache.keys()) if (!files.includes(key)) cache.delete(key);
    const today = localDay(now);
    const ago = n => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    const starts = [today, ago((now.getDay() + 6) % 7), localDay(new Date(now.getFullYear(), now.getMonth(), 1)), ago(364)];
    const year = Object.entries(days).filter(([day]) => day >= starts[3] && day <= today);
    const periods = starts.map(start => {
      const sum = empty();
      for (const [day, v] of year) if (day >= start) add(sum, v);
      return { ...sum, hitRate: sum.cacheInput ? sum.cachedInputTokens / sum.cacheInput : null };
    });
    return { today, start: starts[3], periods, days: Object.fromEntries(year) };
  };
}
