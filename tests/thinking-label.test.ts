import assert from "node:assert/strict";
import test from "node:test";
import { registerThinkingLabeling } from "../src/thinking-label.ts";

type CapturedHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;

function captureThinkingHandlers(labelsEnabled = true): Map<string, CapturedHandler> {
  const handlers = new Map<string, CapturedHandler>();
  registerThinkingLabeling({
    on(eventName: string, handler: CapturedHandler): void {
      handlers.set(eventName, handler);
    },
  } as never, () => labelsEnabled);
  return handlers;
}

test("thinking label formatting prefixes supported provider thinking blocks for display", async () => {
  const handlers = captureThinkingHandlers();
  const event = {
    message: {
      role: "assistant",
      api: "anthropic-messages",
      content: [{ type: "thinking", thinking: "checking options" }],
    },
  };

  await handlers.get("message_update")?.(event, {
    ui: { theme: { fg: (color: string, text: string) => `[${color}]${text}` } },
  });

  assert.deepEqual(event.message.content, [
    { type: "thinking", thinking: "[accent]Thinking: [thinkingText]checking options" },
  ]);
});

test("thinking label formatting leaves unsupported explicit OpenAI APIs unchanged", async () => {
  const handlers = captureThinkingHandlers();
  const thinkingBlock = { type: "thinking", thinking: "raw reasoning" };
  const event = {
    message: {
      role: "assistant",
      api: "openai-chat",
      content: [thinkingBlock],
    },
  };

  await handlers.get("message_end")?.(event, {});

  assert.equal(event.message.content[0], thinkingBlock);
});

test("disabled thinking labels preserve compact-thinking headings while context cleanup remains active", async () => {
  const handlers = captureThinkingHandlers(false);
  const messageEvent = {
    message: {
      role: "assistant",
      api: "anthropic-messages",
      content: [{ type: "thinking", thinking: "**Summary title**" }],
    },
  };

  await handlers.get("message_update")?.(messageEvent, {});
  await handlers.get("message_end")?.(messageEvent, {});
  assert.equal(messageEvent.message.content[0]?.thinking, "**Summary title**");

  const contextEvent = {
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "\u001b[31mThinking: \u001b[0m**Historical title**" }],
    }],
  };
  await handlers.get("context")?.(contextEvent, {});
  assert.equal(contextEvent.messages[0]?.content[0]?.thinking, "**Historical title**");
});

test("thinking context sanitization removes presentation labels before model context", async () => {
  const handlers = captureThinkingHandlers();
  const event = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "\u001b[31mThinking: \u001b[0mThinking: final answer path" },
        ],
      },
      { role: "user", content: "keep me" },
    ],
  };

  await handlers.get("context")?.(event, {});

  assert.deepEqual(event.messages[0]?.content, [
    { type: "thinking", thinking: "final answer path" },
  ]);
  assert.deepEqual(event.messages[1], { role: "user", content: "keep me" });
});
