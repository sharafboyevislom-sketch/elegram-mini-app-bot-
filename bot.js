// Telegram bot: /start bosilganda ism va telefon raqamini so'raydi,
// Supabase'ga saqlaydi, keyin Mini App'ni ochish tugmasini beradi.
//
// O'rnatish: npm install
// Railway Variables: BOT_TOKEN, WEBAPP_URL, SUPABASE_URL, SUPABASE_KEY
 
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
 
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
 
if (!BOT_TOKEN || !WEBAPP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("BOT_TOKEN, WEBAPP_URL, SUPABASE_URL, SUPABASE_KEY hammasi kerak.");
  process.exit(1);
}
 
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
 
// Har bir chat uchun vaqtinchalik holat (ism so'ralyaptimi, raqammi)
const pendingState = new Map(); // chatId -> { step: 'name' | 'phone', name?: string }
 
function openAppKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: "🚀 Ilovani ochish", web_app: { url: WEBAPP_URL } }]],
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
 
  const { data: existing } = await supabase
    .from("customers")
    .select("id, full_name")
    .eq("telegram_id", telegramId)
    .maybeSingle();
 
  if (existing) {
    bot.sendMessage(
      chatId,
      `Xush kelibsiz, ${existing.full_name}! Buyurtma berish uchun tugmani bosing 👇`,
      openAppKeyboard()
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
  bot.sendMessage(chatId, "Rahmat! Endi buyurtma berishingiz mumkin 👇", openAppKeyboard());
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
 
// Mini App ichida tg.sendData(...) chaqirilganda (agar kerak bo'lsa, hozircha ishlatilmaydi
// — buyurtmalar to'g'ridan-to'g'ri Supabase'ga yoziladi)
bot.on("web_app_data", (msg) => {
  console.log("web_app_data:", msg.web_app_data.data);
});
 
console.log("Bot ishga tushdi...");
 
