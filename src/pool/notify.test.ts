import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createToaster, TOAST_REPEAT_MS } from "./notify.js";
import type { ToastClient } from "./notify.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function recordingClient(): { client: ToastClient; shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    client: {
      tui: {
        showToast: async ({ body }) => {
          shown.push(`${body.variant}:${body.message}`);
        },
      },
    },
  };
}

describe("pool toasts", () => {
  it("shows a message once per repeat window", async () => {
    let now = 0;
    const { client, shown } = recordingClient();
    const toast = createToaster(client, () => now);

    toast("warning", "exhausted");
    toast("warning", "exhausted");
    now += TOAST_REPEAT_MS - 1;
    toast("warning", "exhausted");
    now += 1;
    toast("warning", "exhausted");
    toast("info", "switched");
    await flush();

    assert.deepEqual(shown, ["warning:exhausted", "warning:exhausted", "info:switched"]);
  });

  it("dedupes a changing message by its key, and never hides a different severity", async () => {
    const { client, shown } = recordingClient();
    const toast = createToaster(client, () => 0);

    toast("warning", "free in 5m", "exhausted:1");
    toast("warning", "free in 4m", "exhausted:1");
    toast("warning", "free in 9m", "exhausted:2");
    toast("info", "same text");
    toast("error", "same text");
    await flush();

    assert.deepEqual(shown, ["warning:free in 5m", "warning:free in 9m", "info:same text", "error:same text"]);
  });

  it("never throws or rejects when the host cannot show toasts", async () => {
    const rejecting = createToaster({ tui: { showToast: async () => { throw new Error("no tui"); } } });
    const throwing = createToaster({ tui: { showToast: () => { throw new Error("sync"); } } });
    const absent = createToaster({});

    assert.doesNotThrow(() => rejecting("error", "a"));
    assert.doesNotThrow(() => throwing("error", "b"));
    assert.doesNotThrow(() => absent("error", "c"));
    await flush();
  });
});
