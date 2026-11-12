import { appendFileSync } from "node:fs";

// Preloaded into a CLI process by telegram-files.test.ts: requests are logged and answered
// according to the Telegram Bot API endpoint, so no request leaves the machine.
const log = process.env["DORI_TEST_FETCH_LOG"] ?? "";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  // Scrub the bot token from logs.
  const safeUrl = url.replace(/\/bot[^/]+\//, "/bot<token>/");
  const isJson = typeof init?.body === "string";
  const body = isJson ? (JSON.parse(init?.body as string) as Record<string, unknown>) : null;
  if (log) appendFileSync(log, `${JSON.stringify({ url: safeUrl, method: init?.method ?? "GET", body })}\n`);

  if (url.includes("/getFile")) {
    return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_42.jpg", file_size: 5 } }), {
      status: 200,
    });
  }
  if (url.includes("/file/bot")) {
    // Binary download: five bytes spelling "Hello"
    return new Response(new Uint8Array([72, 101, 108, 108, 111]), { status: 200 });
  }
  if (url.includes("/sendPhoto")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
  }
  if (url.includes("/sendDocument")) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
}) as typeof fetch;
