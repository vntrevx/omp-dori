/** dori send, presence, inbound and transcribe: the messengers. */
import { type Command, die, envSlackToken, every, slackAuth } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import { discordPresence } from "./messenger/discord-presence.ts";
import { discordInbound, formatDiscordInbound } from "./messenger/discord-inbound.ts";
import { discordInboundEnv, fileDiscordInboundStore } from "./messenger/discord-inbound-state.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop } from "./messenger/telegram-inbound.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { realClock, run } from "./run.ts";

/** Messenger errors are one line, never a stack. */
export const messengerErrors = [MessengerError, UnsafeMessageError, TranscriptionError] as const;

const NO_SLACK_TOKEN = "DORI_SLACK_TOKEN is not set (nor DORI_SLACK_TOKEN_FILE)";

const send: Command = async ({ key, need, opt, values, config }) => {
  const platform = key ?? die("send needs slack, telegram or discord");
  const to = need("to");
  const text = opt("text");
  const thread = opt("thread");
  const edit = opt("edit");
  const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
  if (platform === "slack") {
    if (opt("file") !== undefined) die("--file is not supported for slack");
    const t = text ?? die("--text is required");
    const slack = new Slack(
      fetchHttp,
      realClock,
      slackAuth(envSlackToken() ?? die(NO_SLACK_TOKEN)),
      undefined,
      new ThreadLedger(`${config.stateDir}/slack-threads.json`),
    );
    if (edit) await slack.edit(to, edit, t);
    else console.log(`SENT ${(await slack.post(to, t, thread)).ts}`);
  } else if (platform === "telegram") {
    // Number("telegram:-1001/42") is NaN, and the Telegram target drops a falsy threadId, so a bad --thread
    // would post to the group's General topic. A flag given empty (--thread "$UNSET") is refused too: no topic
    // means leaving the flag out.
    const id = (flag: string, what: string): number | undefined => {
      if (values[flag] === undefined) return undefined;
      const value = opt(flag) ?? "";
      return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : die(`--${flag} must be a Telegram ${what} id, a whole number above 0`);
    };
    const threadId = id("thread", "topic");
    const target = { chatId: to, ...(threadId !== undefined ? { threadId } : {}) };
    const messageId = id("edit", "message");
    const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
    const filePath = opt("file");
    if (filePath !== undefined && text !== undefined) die("--file and --text are mutually exclusive");
    if (filePath !== undefined) {
      console.log(`SENT ${await tg.sendFile(target, filePath, opt("caption"))}`);
    } else {
      const t = text ?? die("--text or --file is required for telegram");
      if (messageId !== undefined) await tg.edit(target, messageId, t);
      else console.log(`SENT ${await tg.send(target, t)}`);
    }
  } else if (platform === "discord") {
    if (opt("file") !== undefined) die("--file is not supported for discord");
    const t = text ?? die("--text is required");
    const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
    if (edit) await dc.edit(to, edit, t);
    else console.log(`SENT ${await dc.send(thread ?? to, t)}`);
  } else die(`unknown platform ${platform}`);
};

const presence: Command = async ({ key }) => {
  if (key === "slack") {
    const auth = {
      token: envSlackToken() ?? die(NO_SLACK_TOKEN),
      cookie:
        process.env["DORI_SLACK_COOKIE"] ??
        die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)"),
    };
    const p = slackPresence(
      new Slack(fetchHttp, realClock, auth),
      (url, headers) => {
        const options: Bun.WebSocketOptions = { headers: { ...headers } };
        const ws = new WebSocket(url, options);
        return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
      },
      auth,
    );
    console.log("PRESENCE_READY slack");
    await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
  } else if (key === "discord") {
    const token = process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set");
    const p = discordPresence(
      (url) => {
        const ws = new WebSocket(url);
        return {
          send: (data) => ws.send(data),
          close: (code) => ws.close(code),
          onMessage: (cb) => ws.addEventListener("message", (event) => cb(String(event.data))),
          onClose: (cb) => ws.addEventListener("close", (event) => cb(event.code)),
          onError: (cb) => ws.addEventListener("error", () => cb()),
        };
      },
      token,
      {
        now: realClock.now,
        random: Math.random,
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      (line) => console.log(line),
    );
    const stop = () => p.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await p.done;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      p.close();
    }
  } else die("presence needs slack or discord");
};

const telegramInbound = async (stateDir: string, minutes: number): Promise<void> => {
  const tg = new Telegram(
    fetchHttp,
    realClock,
    process.env["DORI_TELEGRAM_TOKEN"] ?? die("DORI_TELEGRAM_TOKEN is not set"),
  );
  const store = fileTgInboundStore(`${stateDir}/telegram-offset`);
  const num = (name: string): number => {
    try {
      return envInt(name, process.env[name]);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e));
    }
  };
  const ownerId = num("DORI_TELEGRAM_OWNER_ID");
  const groupChatId = process.env["DORI_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
  const topicId = process.env["DORI_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID");
  console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
  await telegramInboundLoop(
    tg,
    store,
    {
      ownerId,
      ...(groupChatId !== undefined ? { groupChatId } : {}),
      ...(topicId !== undefined ? { topicId } : {}),
    },
    minutes,
    (i) => console.log(formatTelegramInbound(i)),
    (m) => console.log(`WARN ${m}`.slice(0, 300)),
  );
};

const inbound: Command = async ({ key, loopMinutes, config, values }) => {
  const minutes = loopMinutes();
  if (key === "telegram") return await telegramInbound(config.stateDir, minutes);
  if (key === "discord") {
    const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", process.env["DORI_DISCORD_OWNER_ID"]);
    const channelId = discordInboundEnv("DORI_DISCORD_CHANNEL_ID", process.env["DORI_DISCORD_CHANNEL_ID"]);
    const token = process.env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
    const intake = await discordInbound(
      new Discord(fetchHttp, realClock, token),
      fileDiscordInboundStore(config.stateDir, channelId),
      { ownerId, channelId },
    );
    console.log(`INBOUND_READY discord owner=${ownerId} channel=${channelId} bot=${intake.botId}`);
    await every(values["loop"] === undefined ? 3 / 60 : minutes, async () => {
      await intake.poll((message) => console.log(formatDiscordInbound(message)));
    });
    return;
  }
  if (key !== "slack") die("inbound supports slack, telegram or discord");
  const auth = slackAuth(envSlackToken() ?? die(NO_SLACK_TOKEN));
  const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
  const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
  const me = String((await slack.call("auth.test", {}))["user_id"] ?? die("auth.test returned no user_id"));
  console.log("INBOUND_READY slack");
  await every(minutes, async () => {
    for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me }))
      console.log(
        `INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`,
      );
  });
};

const file: Command = async ({ key, need, positionals }) => {
  const sub = key ?? die("file needs get");
  if (sub !== "get") die(`file ${sub} is not supported`);
  const platform = positionals[1] ?? die("file get needs telegram");
  if (platform !== "telegram") die(`file get ${platform} is not supported`);
  const token = process.env["DORI_TELEGRAM_TOKEN"] ?? die("DORI_TELEGRAM_TOKEN is not set");
  const fileId = need("file-id");
  const outPath = need("out");
  const tg = new Telegram(fetchHttp, realClock, token);
  const bytes = await tg.downloadToPath(fileId, outPath);
  console.log(`GOT ${outPath} ${bytes}`);
};

export const messengerCommands: Readonly<Record<string, Command>> = {
  send,
  presence,
  inbound,
  file,
  transcribe: async ({ key, config }) => {
    console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
  },
};
