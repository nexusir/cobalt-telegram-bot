require("dotenv").config();

const { Telegraf, Markup, Input } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const COBALT_URL = (process.env.COBALT_URL || "").replace(/\/+$/, "");
const COBALT_AUTH = process.env.COBALT_AUTH || "";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 50331648);
const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || "")
    .split(",").map(x => x.trim()).filter(Boolean)
);

if (!BOT_TOKEN || !COBALT_URL) {
  console.error("BOT_TOKEN and COBALT_URL are required.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const jobs = new Map(); // callback selections, in-memory only
const active = new Set();

const HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  ...(COBALT_AUTH ? { Authorization: COBALT_AUTH } : {})
};

const EMOJI = {
  hello: "✨",
  link: "🔗",
  video: "🎬",
  audio: "🎵",
  download: "⬇️",
  wait: "⏳",
  ok: "✅",
  error: "⚠️",
  info: "ℹ️"
};

function allowed(ctx) {
  return ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(String(ctx.from?.id));
}

function cleanName(name) {
  return String(name || "download")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .slice(0, 170);
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") &&
      Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎬 ویدیو", "mode:video"),
     Markup.button.callback("🎵 موسیقی", "mode:audio")],
    [Markup.button.callback("ℹ️ راهنما", "help")]
  ]);
}

async function safeDelete(ctx, messageId) {
  try { await ctx.telegram.deleteMessage(ctx.chat.id, messageId); } catch {}
}

async function callCobalt(url, mode, quality) {
  const body = {
    url,
    downloadMode: mode === "audio" ? "audio" : "auto",
    videoQuality: quality || "720",
    audioFormat: "mp3",
    audioBitrate: "192",
    filenameStyle: "pretty",
    youtubeVideoCodec: "h264"
  };

  const response = await axios.post(`${COBALT_URL}/`, body, {
    headers: HEADERS,
    timeout: 90000,
    maxBodyLength: 1024 * 1024,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: s => s >= 200 && s < 500
  });
  return response.data;
}

function cobaltErrorText(data) {
  const code = data?.error?.code || "unknown";
  const messages = {
    "youtube.login": "این محتوا نیاز به ورود دارد.",
    "youtube.age-restricted": "این ویدیو محدودیت سنی دارد.",
    "youtube.region": "این محتوا در منطقهٔ فعلی در دسترس نیست.",
    "content.unavailable": "محتوا در دسترس نیست یا حذف شده است.",
    "content.private": "این محتوا خصوصی است.",
    "link.unsupported": "این لینک توسط Cobalt پشتیبانی نمی‌شود.",
    "rate-limit": "محدودیت درخواست فعال شده؛ کمی بعد دوباره تلاش کن."
  };
  return messages[code] || `Cobalt خطا داد: ${code}`;
}

async function downloadAndSend(ctx, fileUrl, filename, mode) {
  if (!isHttpUrl(fileUrl)) throw new Error("Cobalt یک لینک دانلود معتبر برنگرداند.");

  const tempPath = path.join(os.tmpdir(), `cobalt-${crypto.randomUUID()}-${cleanName(filename)}`);
  let sent = false;

  try {
    const response = await axios.get(fileUrl, {
      responseType: "stream",
      timeout: 180000,
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 300
    });

    const length = Number(response.headers["content-length"] || 0);
    if (length && length > MAX_UPLOAD_BYTES) {
      response.data.destroy();
      await ctx.reply(
        `فایل حدود ${(length / 1024 / 1024).toFixed(1)} مگابایت است و از سقف آپلود تنظیم‌شدهٔ ربات بیشتر است.\n` +
        `لینک دانلود مستقیم:\n${fileUrl}`
      );
      return;
    }

    let bytes = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tempPath);
      response.data.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES) {
          response.data.destroy(new Error("FILE_TOO_LARGE"));
          out.destroy(new Error("FILE_TOO_LARGE"));
        }
      });
      response.data.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      response.data.pipe(out);
    });

    if (!bytes || !fs.existsSync(tempPath)) throw new Error("فایل خالی دریافت شد.");

    const caption = `${EMOJI.ok} دانلود آماده شد`;
    const file = Input.fromLocalFile(tempPath, cleanName(filename));

    if (mode === "audio") {
      await ctx.replyWithAudio(file, { caption, title: path.parse(filename).name });
    } else if (/\.(mp4|m4v|mov|webm)$/i.test(filename)) {
      await ctx.replyWithVideo(file, { caption, supports_streaming: true });
    } else {
      await ctx.replyWithDocument(file, { caption });
    }
    sent = true;
  } catch (err) {
    if (err.message === "FILE_TOO_LARGE") {
      await ctx.reply(`حجم فایل از سقف آپلود ربات بیشتر شد.\nلینک دانلود مستقیم:\n${fileUrl}`);
      return;
    }
    throw err;
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
  return sent;
}

async function processResult(ctx, data, mode) {
  if (!data || typeof data !== "object") throw new Error("پاسخ Cobalt قابل‌خواندن نیست.");

  if (data.status === "error") throw new Error(cobaltErrorText(data));

  if (data.status === "tunnel" || data.status === "redirect") {
    await downloadAndSend(ctx, data.url, data.filename || (mode === "audio" ? "audio.mp3" : "video.mp4"), mode);
    return;
  }

  if (data.status === "picker") {
    const items = Array.isArray(data.picker) ? data.picker.slice(0, 10) : [];
    if (!items.length) throw new Error("Cobalt موردی برای انتخاب برنگرداند.");
    const token = crypto.randomUUID().slice(0, 8);
    jobs.set(token, { items, mode, owner: ctx.from.id, chat: ctx.chat.id });
    const rows = items.map((item, i) => [
      Markup.button.callback(
        `${item.type === "photo" ? "🖼️" : item.type === "gif" ? "GIF" : "🎬"} مورد ${i + 1}`,
        `pick:${token}:${i}`
      )
    ]);
    await ctx.reply("چند فایل پیدا شد؛ مورد دلخواه را انتخاب کن:", Markup.inlineKeyboard(rows));
    return;
  }

  if (data.status === "local-processing") {
    throw new Error("این مورد به پردازش محلی/FFmpeg نیاز دارد و در نسخهٔ فعلی ربات فعال نشده است.");
  }

  throw new Error(`وضعیت ناشناخته از Cobalt: ${data.status || "بدون status"}`);
}

bot.start(async ctx => {
  if (!allowed(ctx)) return ctx.reply("دسترسی شما به این ربات فعال نیست.");
  await ctx.reply(
    `${EMOJI.hello} به دانلودر Cobalt خوش آمدی.\n\nلینک ویدیو یا موسیقی را بفرست، سپس نوع دانلود و کیفیت را انتخاب کن.`,
    mainKeyboard()
  );
});

bot.command("help", ctx => ctx.reply(
  "راهنما:\n۱) لینک عمومی محتوا را ارسال کن.\n۲) ویدیو یا موسیقی را انتخاب کن.\n۳) کیفیت را انتخاب کن.\n\nربات از سرویس‌هایی پشتیبانی می‌کند که نمونهٔ Cobalt شما پشتیبانی می‌کند. محتوای خصوصی، پولی یا دارای محدودیت دسترسی ممکن است قابل دریافت نباشد."
));

bot.command("status", async ctx => {
  try {
    const r = await axios.get(`${COBALT_URL}/`, { timeout: 15000 });
    const c = r.data?.cobalt || {};
    await ctx.reply(`وضعیت Cobalt: ${EMOJI.ok}\nنسخه: ${c.version || "نامشخص"}\nسرویس‌ها: ${c.services?.length || 0}`);
  } catch {
    await ctx.reply(`${EMOJI.error} ارتباط با Cobalt برقرار نشد.`);
  }
});

bot.action("help", async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply("لینک عمومی محتوا را بفرست؛ سپس نوع دانلود و کیفیت را انتخاب کن.");
});

bot.action(/^mode:(video|audio)$/, async ctx => {
  await ctx.answerCbQuery();
  const mode = ctx.match[1];
  const pending = ctx.session?.pendingUrl;
  // Telegraf session is intentionally not required; URL is stored per-user below.
  const url = userUrls.get(ctx.from.id);
  if (!url) return ctx.reply("اول لینک را ارسال کن.");
  if (mode === "audio") return startDownload(ctx, url, "audio", "720");

  await ctx.reply("کیفیت ویدیو را انتخاب کن:", Markup.inlineKeyboard([
    ["1080", "720", "480"].map(q => Markup.button.callback(`${q}p`, `quality:${q}`)),
    ["360", "240"].map(q => Markup.button.callback(`${q}p`, `quality:${q}`))
  ]));
});

const userUrls = new Map();

async function startDownload(ctx, url, mode, quality) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  if (active.has(key)) return ctx.reply("یک دانلود دیگر در حال انجام است؛ کمی صبر کن.");
  active.add(key);
  const status = await ctx.reply(`${EMOJI.wait} در حال پردازش لینک با Cobalt...`);
  try {
    const data = await callCobalt(url, mode, quality);
    await safeDelete(ctx, status.message_id);
    await processResult(ctx, data, mode);
  } catch (err) {
    await safeDelete(ctx, status.message_id);
    const msg = err.response?.data?.error?.code
      ? cobaltErrorText(err.response.data)
      : (err.message || "خطای نامشخص");
    await ctx.reply(`${EMOJI.error} ${msg}`);
  } finally {
    active.delete(key);
  }
}

bot.action(/^quality:(\d{3,4})$/, async ctx => {
  await ctx.answerCbQuery();
  const url = userUrls.get(ctx.from.id);
  if (!url) return ctx.reply("لینک قبلی منقضی شده؛ دوباره لینک را بفرست.");
  await startDownload(ctx, url, "video", ctx.match[1]);
});

bot.action(/^pick:([a-f0-9-]+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const [, token, index] = ctx.match;
  const job = jobs.get(token);
  if (!job || job.owner !== ctx.from.id || job.chat !== ctx.chat.id) {
    return ctx.reply("این انتخاب منقضی شده است؛ لینک را دوباره ارسال کن.");
  }
  const item = job.items[Number(index)];
  if (!item || !isHttpUrl(item.url)) return ctx.reply("لینک این مورد معتبر نیست.");
  jobs.delete(token);
  try {
    await downloadAndSend(ctx, item.url, `cobalt-item-${Number(index) + 1}.${item.type === "photo" ? "jpg" : item.type === "gif" ? "gif" : "mp4"}`, job.mode);
  } catch (err) {
    await ctx.reply(`${EMOJI.error} ${err.message || "ارسال فایل ناموفق بود."}`);
  }
});

bot.on("text", async ctx => {
  if (!allowed(ctx)) return ctx.reply("دسترسی شما به این ربات فعال نیست.");
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  if (!isHttpUrl(text)) {
    return ctx.reply("یک لینک معتبر با http یا https بفرست.");
  }
  userUrls.set(ctx.from.id, text);
  // prevent unbounded memory growth
  if (userUrls.size > 5000) userUrls.delete(userUrls.keys().next().value);
  await ctx.reply("لینک دریافت شد. نوع دانلود را انتخاب کن:", mainKeyboard());
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  ctx.reply("خطای داخلی رخ داد؛ دوباره تلاش کن.").catch(() => {});
});

bot.launch().then(() => console.log("Cobalt Telegram bot is running."));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
