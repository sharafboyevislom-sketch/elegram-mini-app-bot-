// Telegram bot: /start bosilganda ism va telefon raqamini so'raydi,
// Supabase'ga saqlaydi, keyin Mini App'ni ochish tugmasini beradi.
// Shuningdek, Supabase'dan kelgan "yangi buyurtma" webhook'ini qabul qilib,
// buyurtmalar guruhiga xabar yuboradi.
//
// O'rnatish: npm install
// Railway Variables: BOT_TOKEN, WEBAPP_URL, SUPABASE_URL, SUPABASE_KEY,
//                     GROUP_CHAT_ID, WEBHOOK_SECRET

require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // ixtiyoriy — bo'lmasa guruhga xabar yuborilmaydi
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // ixtiyoriy — bo'lsa webhook shu maxfiy so'z bilan himoyalanadi

if (!BOT_TOKEN || !WEBAPP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("BOT_TOKEN, WEBAPP_URL, SUPABASE_URL, SUPABASE_KEY hammasi kerak.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Har bir chat uchun vaqtinchalik holat (ism so'ralyaptimi, raqammi)
const pendingState = new Map(); // chatId -> { step: 'name' | 'phone', name?: string }

function openAppKeyboard(telegramId) {
  const url = `${WEBAPP_URL}?tid=${telegramId}`;
  return {
    reply_markup: {
      keyboard: [[{ text: "🚀 Ilovani ochish", web_app: { url } }]],
      resize_keyboard: true,
    },
  };
}

function contactKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  // Guruh ichida /start ishlatilsa, guruh chat_id'sini konsolga chiqaramiz
  // (GROUP_CHAT_ID sozlashda foydalanish uchun)
  if (msg.chat.type !== "private") {
    console.log("Guruh chat_id:", chatId, "| Guruh nomi:", msg.chat.title);
    return;
  }

  const { data: existing } = await supabase
    .from("customers")
    .select("id, full_name")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (existing) {
    bot.sendMessage(
      chatId,
      `Xush kelibsiz, ${existing.full_name}! Buyurtma berish uchun tugmani bosing 👇`,
      openAppKeyboard(telegramId)
    );
    return;
  }

  pendingState.set(chatId, { step: "name" });
  bot.sendMessage(chatId, "Assalomu alaykum! Ismingizni kiriting:");
});

bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const state = pendingState.get(chatId);
  if (!state || state.step !== "phone") return;

  const telegramId = msg.from.id;
  const phone = msg.contact.phone_number;

  await supabase.from("customers").upsert(
    {
      telegram_id: telegramId,
      full_name: state.name,
      phone,
    },
    { onConflict: "telegram_id" }
  );

  pendingState.delete(chatId);
  bot.sendMessage(chatId, "Rahmat! Endi buyurtma berishingiz mumkin 👇", openAppKeyboard(telegramId));
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const state = pendingState.get(chatId);
  if (!state) return;
  if (msg.text && msg.text.startsWith("/")) return; // buyruqlarni bu yerda ishlatmaymiz
  if (msg.contact) return; // yuqoridagi handler ishlaydi

  if (state.step === "name") {
    const name = (msg.text || "").trim();
    if (!name) {
      bot.sendMessage(chatId, "Iltimos, ismingizni matn sifatida yozing.");
      return;
    }
    pendingState.set(chatId, { step: "phone", name });
    bot.sendMessage(chatId, `Rahmat, ${name}! Endi telefon raqamingizni yuboring:`, contactKeyboard());
  }
});

bot.on("web_app_data", (msg) => {
  console.log("web_app_data:", msg.web_app_data.data);
});

// ==== HTTP server: Supabase'dan "yangi buyurtma" webhook'ini qabul qilish ====
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("Bot ishlayapti."));

app.post("/webhook/new-order", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"];
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).send("Ruxsat yo'q");
    }
  }

  try {
    const order = req.body.record; // Supabase webhook "record" ichida yangi qatorni yuboradi

    const { data: business } = await supabase
      .from("businesses")
      .select("name, group_chat_id")
      .eq("id", order.business_id)
      .maybeSingle();

    const targetChatId = business?.group_chat_id || GROUP_CHAT_ID;
    if (!targetChatId) {
      console.log("Guruh ID topilmadi (na biznesda, na GROUP_CHAT_ID'da), xabar yuborilmadi.");
      return res.status(200).send("OK (guruh sozlanmagan)");
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("full_name, phone")
      .eq("id", order.customer_id)
      .maybeSingle();

    const { data: items } = await supabase
      .from("order_items")
      .select("product_name, quantity")
      .eq("order_id", order.id);

    const itemsText = (items || []).map((it) => `• ${it.product_name} ×${it.quantity}`).join("\n");
    const locationText = order.latitude && order.longitude
      ? `\n📍 https://maps.google.com/?q=${order.latitude},${order.longitude}`
      : "";

    const text =
      `🆕 Yangi buyurtma! (${business?.name || "Noma'lum do'kon"})\n\n` +
      `👤 ${customer?.full_name || "Noma'lum"}\n` +
      `📞 ${customer?.phone || "—"}\n\n` +
      `${itemsText}\n\n` +
      `🏠 ${order.address_text || "—"}${locationText}\n` +
      `💰 ${Number(order.total_amount).toLocaleString("uz-UZ")} so'm`;

    await bot.sendMessage(targetChatId, text);
    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook xatosi:", err);
    res.status(500).send("Xatolik");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda ishlayapti`));

console.log("Bot ishga tushdi...");
