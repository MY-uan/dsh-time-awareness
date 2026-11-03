// dsh-time-awareness
// 给 QQ Bot 会话注入「实时时间」和「距上次对话的时间」，让角色能感知时间变化。
//
// 关键设计：
// - 走 dsh-qqbot 的 ctx.qqbot.runtime()，写入 qqbot:runtime context，
//   而不是系统提示词 section。所以：
//   1) 用户收到的消息里看不见这行时间；
//   2) 它不属于系统提示词前缀，时间每秒变化也不会打断前缀缓存（省 token）。
// - 「距上次对话」落盘到 <DSH_HOME>/dsh-time-awareness/last-seen.json，
//   重启 DSH 后依然能算出隔了多久。
// - 没装 dsh-qqbot 时，ctx.inject(['qqbot']) 永远不会触发，本插件安静地什么都不做。

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const name = "dsh-time-awareness";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 间隔小于这个值就显示「刚刚（不到 1 分钟）」。
const MIN_REPORT_MS = 60_000; // 1 分钟
// 同一轮里可能被多次组装；这个窗口内直接复用上一次算好的文本，
// 避免重复组装把「距上次对话」错算成「刚刚」。
const TURN_DEBOUNCE_MS = 5_000; // 5 秒
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

export function apply(ctx) {
  ctx.inject(["qqbot"], (inner) => {
    // 每个 QQ 会话记录上一次组装的时间，用来算「距上次对话」。启动时从磁盘读回。
    const lastSeen = loadLastSeen();
    // sessionId -> { text, at }：同一轮内的缓存，防止重复组装把间隔错算成「刚刚」。
    const recent = new Map();
    let saveTimer;

    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        saveLastSeen(lastSeen);
      }, 1000);
    };

    inner.effect(() =>
      inner.qqbot.runtime("time", (session) => {
        const now = Date.now();

        // 同一轮被再次组装时，直接复用上一次算好的文本，不推进“上次时间”。
        const cached = recent.get(session.id);
        if (cached !== undefined && now - cached.at < TURN_DEBOUNCE_MS) {
          return cached.text;
        }

        const previous = lastSeen.get(session.id);

        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
        let gapText;
        if (previous === undefined) {
          gapText = "距上次对话：首次对话";
        } else if (now - previous < MIN_REPORT_MS) {
          gapText = "距上次对话：刚刚（不到 1 分钟）";
        } else {
          gapText = `距上次对话：约 ${humanize(now - previous)}`;
        }
        const text = `当前时间：${formatTime(new Date(now))}（${zone}）；${gapText}`;

        lastSeen.set(session.id, now);
        scheduleSave();
        recent.set(session.id, { text, at: now });

        return text;
      })
    );

    // 卸载前把还没落盘的最后一次改动写掉。
    inner.effect(() => () => {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        saveLastSeen(lastSeen);
      }
    });
  });
}
