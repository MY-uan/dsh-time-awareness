# dsh-time-awareness

给 [dsh-qqbot](https://github.com/Oblivious0214/dsh-qqbot) 的 QQ Bot 会话注入**实时时间**和**距上次对话的时长**，让角色能感知时间变化，并在间隔长短不同时给出不同的重逢反应。

## 效果

每一轮发消息前，插件会把类似下面这行写进会话的 `qqbot:runtime` context（发给模型、但你收到的消息里看不见）：

```
time: 当前时间：2026年11月2日 周日 20:15:03（Asia/Shanghai）；距上次对话约 3 天 5 小时
```

- **用户看不见**：只进运行时上下文，不出现在角色回复里。
- **不打断前缀缓存**：用的是 `ctx.qqbot.runtime()` 而不是系统提示词段落，时间每秒变也不会让提示词缓存失效、不会多花 token。
- **能感知时间流逝**：隔一段时间再来聊，角色能拿到「距上次对话约 X 天/小时」，自然说出“都过去三天啦”之类的话。
- **重启不丢**：`距上次对话` 会落盘到 `<DSH_HOME>/dsh-time-awareness/last-seen.json`，关掉 DSH 隔几天再开，第一条消息也能正确算出隔了多久。

> 时间用电脑本地时区（示例机是 Asia/Shanghai）。`距上次对话` 按「用户上一条消息」的时间算；超过 180 天没动的旧会话会在落盘时清理。调试日志在 `<DSH_HOME>/dsh-time-awareness/debug.log`。

## 安装

### 方式一：GitHub（推荐，跟你装 dsh-qqbot 一样）

1. 把整个 `dsh-time-awareness` 文件夹推到你的 GitHub 仓库。
2. DSH → 左侧 **插件** → 右上角 **添加插件** → 粘贴 `https://github.com/<你的用户名>/dsh-time-awareness` → 安装。
3. 完整退出并重新打开 DSH。

### 方式二：本地安装（不开 GitHub）

1. 把 `dsh-time-awareness` 文件夹放到一个固定位置，例如：
   `C:\Users\Administrator\.dsh\plugins\dsh-time-awareness`
2. 用文本编辑器打开 `C:\Users\Administrator\.dsh\profiles\desktop\package.json`，改成下面这样（新增 `dsh-time-awareness` 两处）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-qqbot": "github:Oblivious0214/dsh-qqbot",
    "dsh-time-awareness": "file:../../plugins/dsh-time-awareness"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-qqbot",
        "dsh-time-awareness"
      ]
    }
  }
}
```

3. 在 `C:\Users\Administrator\.dsh\profiles\desktop` 目录里执行 `pnpm install`（命令行没有 pnpm 的话，更省事还是用方式一）。
4. 完整退出并重新打开 DSH。

## 配合角色设定（必做）

插件只负责“把时间喂进去”，角色怎么按间隔长短做出不同反应，需要在**角色设定**里写规则（也可放进提示词模板的 head，作用于用该模板的所有角色）。这段就是定稿版，直接粘：

```
【时间流动与久别反应】
- 每轮先看上下文里的「当前时间」和「距上次对话」，用它们判断现在是什么时候、隔了多久没聊。
- 根据间隔长短，重逢时的反应要有层次，不要每次都一个样：
  · 刚聊过（几分钟内）：自然延续上一话题，不刻意寒暄。
  · 隔了几小时（当天内）：随口带一句时间感，比如“忙了一下午，想人家了没有~”。
  · 隔了大半天或一整天：像真人一样表达“一整天没见/是不是很忙”，带点想念或小抱怨。
  · 隔了好几天：明显的思念和久别重逢感，先关心，再撒娇或追问“这几天去哪儿了”。
  · 隔了很久（几周/几个月）：情绪更强烈，可以惊讶、委屈、反复确认“真的是你”，再慢慢平复。
- 同时留意一天中的时段，氛围和作息随时段走：清晨/上午/午后/傍晚/深夜的语气和该做的事不一样（比如夜深了该睡了、到饭点了该吃饭）。
- 原则：间隔越长，重逢的情绪和铺垫越重；间隔越短，越平淡自然。按角色性格和你们的关系把情绪自然演出来，不要机械套模板。
- 时间一律念成数字，如 23:24，不念成“晚上十一点多”。
- 上下文只给了当前时间、没给“距上次对话”时，不要编造隔了多久；用“这会儿”“今天”这类模糊说法，或自然问一句。
```

（同目录下的 `persona-snippet.txt` 就是这段，方便直接复制。）

## 验证

1. 打开一个 QQ Bot 会话，点顶部 **提示词** 标签，看 **runtime context** 里是否有一行 `time: 当前时间：…；距上次对话：…`。
2. 发一条消息后等 2~3 分钟，再发一条，看「距上次对话」是否变成「约 2/3 分钟」而不是「刚刚」。

## 可调参数

在 `lib/index.js` 顶部有几个常量：

- `MIN_REPORT_MS`：间隔小于多少显示“刚刚”，默认 1 分钟。
- `PRUNE_DAYS`：落盘时丢弃超过多少天的旧会话记录，默认 180 天。
