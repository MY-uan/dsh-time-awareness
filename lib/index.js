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

// 间隔小于这个值就不提示「距上次对话」，避免快速来回时的噪音。
const MIN_REPORT_MS = 60_000; // 1 分钟
// 同一轮里可能被多次组装；间隔小于这个值不更新「上次时间」，避免抹掉真实间隔。
const MIN_UPDATE_MS = 2_000; // 2 秒
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

function dataDir() {
  const configured = process.env["DSH_HOME"]?.trim() ?? "";
  return join(configured === "" ? homedir() : configured, "dsh-time-awareness");
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
        const previous = lastSeen.get(session.id);

        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
        let text = `当前时间：${formatTime(new Date(now))}（${zone}）`;

        if (previous !== undefined && now - previous >= MIN_REPORT_MS) {
          text += `；距上次对话约 ${humanize(now - previous)}`;
        }

        if (previous === undefined || now - previous >= MIN_UPDATE_MS) {
          lastSeen.set(session.id, now);
          scheduleSave();
        }

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
