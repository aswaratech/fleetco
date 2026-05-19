// Slack bot for inbound slash commands + AI fallback.
//
// Principle 8 from docs/runbook/orchestration-loop-design.md (bidirectional
// extension). Uses Socket Mode so no public HTTPS endpoint is needed; runs
// from the operator's laptop alongside the main loop.
//
// Slash commands:
//   /status — iter count, current PR, CI status, time on wait, last few decisions
//   /tail — last 30 lines of decisions.log
//   /stop — touch .stop sentinel (loop halts cleanly at next iter boundary)
//   /resume — delete .stop sentinel
//   /queue — kickoff.md content + program scope
// AI fallback: any non-command message goes to Haiku with recent log tail as context.

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { env, paths } from "./config.js";
import { tailDecisions } from "./logging.js";
import { loadState } from "./state.js";

export interface SlackBotHandle {
  stop: () => Promise<void>;
}

export interface SlackBotOptions {
  /** Override Haiku client for tests. */
  haikuReply?: (userText: string, context: string) => Promise<string>;
}

const defaultHaikuReply = async (userText: string, context: string): Promise<string> => {
  const client = new Anthropic({});
  const sys =
    "You are a brief operations assistant for the FleetCo orchestration loop. " +
    "Answer the operator's question concisely (1-3 short sentences). " +
    "Base your answer on the log context provided. If the answer isn't in the context, say so plainly.";
  const resp = await client.messages.create({
    model: env.ORCHESTRATION_HAIKU_MODEL,
    max_tokens: 600,
    system: sys,
    messages: [
      { role: "user", content: `Question: ${userText}\n\nLog context (most recent):\n${context}` },
    ],
  });
  return resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
};

export async function startSlackBot(options: SlackBotOptions = {}): Promise<SlackBotHandle | null> {
  if (!env.SLACK_APP_TOKEN || !env.SLACK_BOT_TOKEN) {
    // Bot not configured — operator runs notification-only mode.
    return null;
  }
  const socket = new SocketModeClient({ appToken: env.SLACK_APP_TOKEN });
  const web = new WebClient(env.SLACK_BOT_TOKEN);
  const haikuReply = options.haikuReply ?? defaultHaikuReply;

  socket.on("slash_commands", async ({ body, ack }: { body: any; ack: (response?: any) => Promise<void> }) => {
    const cmd = (body?.command ?? "").toString();
    try {
      switch (cmd) {
        case "/status":
          await ack({ response_type: "ephemeral", text: renderStatus() });
          break;
        case "/tail":
          await ack({ response_type: "ephemeral", text: "```\n" + tailDecisions(30) + "\n```" });
          break;
        case "/stop":
          try {
            fs.writeFileSync(paths.stopSentinel, new Date().toISOString());
            await ack({
              response_type: "in_channel",
              text: ":octagonal_sign: Stop sentinel touched. The loop will halt cleanly at the next iteration boundary.",
            });
          } catch (err) {
            await ack({ response_type: "ephemeral", text: `Failed to touch .stop: ${String(err)}` });
          }
          break;
        case "/resume":
          try {
            if (fs.existsSync(paths.stopSentinel)) fs.rmSync(paths.stopSentinel);
            await ack({
              response_type: "in_channel",
              text: ":arrows_counterclockwise: Stop sentinel removed. Operator must `pnpm start` to relaunch the loop.",
            });
          } catch (err) {
            await ack({ response_type: "ephemeral", text: `Failed to remove .stop: ${String(err)}` });
          }
          break;
        case "/queue":
          await ack({ response_type: "ephemeral", text: renderQueue() });
          break;
        default:
          await ack({ response_type: "ephemeral", text: `Unknown command: ${cmd}` });
      }
    } catch (err) {
      try {
        await ack({ response_type: "ephemeral", text: `Bot error: ${String(err)}` });
      } catch {
        // ack already consumed
      }
    }
  });

  socket.on("app_mention", async ({ event, ack }: { event: any; ack?: () => Promise<void> }) => {
    if (ack) await ack();
    try {
      const text: string = (event?.text ?? "").replace(/<@[A-Z0-9]+>\s*/g, "").trim();
      if (!text) return;
      const context = tailDecisions(50);
      const answer = await haikuReply(text, context);
      await web.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: answer || "(no answer)",
      });
    } catch (err) {
      try {
        await web.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts ?? event.ts,
          text: `Bot error: ${String(err)}`,
        });
      } catch {
        // best-effort
      }
    }
  });

  await socket.start();

  return {
    stop: async () => {
      try {
        await socket.disconnect();
      } catch {
        // best-effort
      }
    },
  };
}

function renderStatus(): string {
  const state = loadState();
  const lastDecisions = tailDecisions(5);
  return [
    `*iter:* ${state.iteration}`,
    `*lastPrNumber:* ${state.lastPrNumber ?? "(none)"}`,
    `*lastIterStartedAt:* ${state.lastIterStartedAt ?? "(none)"}`,
    `*rateLimitRetries (this iter):* ${state.rateLimitRetries}`,
    `*programDoneSentinelSeen:* ${state.programDoneSentinelSeen}`,
    `*stop sentinel:* ${fs.existsSync(paths.stopSentinel) ? ":octagonal_sign: present" : "absent"}`,
    "",
    "*Last 5 decisions:*",
    "```",
    lastDecisions,
    "```",
  ].join("\n");
}

function renderQueue(): string {
  let kickoff: string;
  try {
    kickoff = fs.existsSync(paths.kickoffFile) ? fs.readFileSync(paths.kickoffFile, "utf8") : "(kickoff.md absent)";
  } catch (err) {
    kickoff = `(failed to read kickoff.md: ${String(err)})`;
  }
  const truncated = kickoff.length > 3500 ? kickoff.slice(0, 3500) + "\n…(truncated)" : kickoff;
  return [`*Current kickoff.md:*`, "```", truncated, "```"].join("\n");
}
