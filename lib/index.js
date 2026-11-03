// dsh-time-awareness
// 给 QQ Bot 会话注入「实时时间」和「距上次对话的时间」，让角色能感知时间变化。
//
// 关键设计：
// - 走 dsh-qqbot 的 ctx.qqbot.runtime()，写入 qqbot:runtime context，
//   而不是系统提示词 section。所以用户消息里看不见、也不打断前缀缓存。
// - 「距上次对话」只在「用户消息进入收件箱」这个可靠时机算一次并落盘，
//   runtime 回调只读取结果、不更新状态，避免重复组装把间隔抹平。
// - 没装 dsh-qqbot 时，ctx.inject(['qqbot']) 永远不会触发，本插件安静地什么都不做。

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const name = "dsh-time-awareness";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 间隔小于这个值就显示「刚刚（不到 1 分钟）」。
const MIN_REPORT_MS = 60_000; // 1 分钟
// 落盘时丢弃超过这个天数的旧会话，避免文件无限增长。
const PRUNE_DAYS = 180;

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(date) {
  return (
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` +
    ` ${WEEKDAYS[date.getDay()]}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function humanize(ms) {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remMinutes} 分钟`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 30) {
    return remHours === 0 ? `${days} 天` : `${days} 天 ${remHours} 小时`;
  }
  const months = Math.floor(days / 30);
  const remDays = days % 30;
  return remDays === 0 ? `约 ${months} 个月` : `约 ${months} 个月 ${remDays} 天`;
}

// DSH 的数据根目录：优先用 DSH_HOME，否则回退到 ~/.dsh（和 dsh-qqbot 一致）。
function dataDir() {
  const configured = process.env["DSH_HOME"]?.trim() ?? "";
  const home = configured === "" ? join(homedir(), ".dsh") : configured;
  return join(home, "dsh-time-awareness");
}

function loadLastSeen() {
  try {
    const file = join(dataDir(), "last-seen.json");
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return new Map();
    const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
    const map = new Map();
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= cutoff) {
        map.set(key, value);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveLastSeen(map) {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last-seen.json"), JSON.stringify(Object.fromEntries(map)), "utf8");
  } catch {
    // 写失败不影响提示词，静默忽略。
  }
}

function logDebug(msg) {
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "debug.log"), `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    // 日志失败静默忽略。
  }
}

export function apply(ctx) {
  // 每个会话记录「用户上一条消息的时间」，用来算「距上次对话」。启动时从磁盘读回。
  const lastUserMessage = loadLastSeen();
  // 每个会话当前这一轮算好的间隔文本，runtime 回调直接读它。
  const pendingGap = new Map();
  let saveTimer;

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saveLastSeen(lastUserMessage);
    }, 1000);
  };

  // 可靠时机：用户消息进入收件箱时，算一次间隔，并推进「上次消息时间」。
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message.source?.kind !== "user") return;
    const now = Date.now();
    const previous = lastUserMessage.get(agent.id);

    let gapText;
    if (previous === undefined) {
      gapText = "距上次对话：首次对话";
    } else {
      const gap = now - previous;
      gapText = gap < MIN_REPORT_MS
        ? "距上次对话：刚刚（不到 1 分钟）"
        : `距上次对话：约 ${humanize(gap)}`;
    }

    pendingGap.set(agent.id, gapText);
    lastUserMessage.set(agent.id, now);
    scheduleSave();
    logDebug(
      `[user-msg] session=${agent.id} previous=${previous ?? "none"} now=${now}` +
      ` gapMs=${previous === undefined ? "none" : now - previous} -> ${gapText}`
    );
  });

  // 卸载前把还没落盘的最后一次改动写掉。
  ctx.effect(() => () => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      saveLastSeen(lastUserMessage);
    }
  });

  ctx.inject(["qqbot"], (inner) => {
    inner.effect(() =>
      inner.qqbot.runtime("time", (session) => {
        const now = Date.now();
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
        // 只读：间隔在 user-msg 事件里已经算好，这里不做任何状态更新。
        const gapText = pendingGap.get(session.id) ?? "距上次对话：首次对话";
        return `当前时间：${formatTime(new Date(now))}（${zone}）；${gapText}`;
      })
    );
  });
}
