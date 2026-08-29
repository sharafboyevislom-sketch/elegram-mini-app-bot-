// Telegram bot: Mini App'ni ochadi va undan kelgan ma'lumotni qabul qiladi.
//
// O'rnatish:
//   npm install
//   BOT_TOKEN va WEBAPP_URL ni .env fayliga yozing (.env.example ga qarang)
//   npm start
 
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
 
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // masalan: https://sizning-domeningiz.com
 
if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error("BOT_TOKEN va WEBAPP_URL .env faylida ko'rsatilishi shart.");
  process.exit(1);
}
 
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
 
// /start bosilganda Mini App'ni ochuvchi tugmani yuboradi.
// MUHIM: tg.sendData() faqat pastdagi klaviatura (reply keyboard) orqali
// ochilgan Web App'larda ishlaydi — inline tugmada ishlamaydi.
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Xush kelibsiz! Ilovani ochish uchun quyidagi tugmani bosing 👇", {
    reply_markup: {
      keyboard: [
        [{ text: "🚀 Ilovani ochish", web_app: { url: WEBAPP_URL } }],
      ],
      resize_keyboard: true,
    },
  });
});
 
// Mini App ichida tg.sendData(...) chaqirilganda shu handler ishlaydi
bot.on("web_app_data", (msg) => {
  const chatId = msg.chat.id;
  try {
    const data = JSON.parse(msg.web_app_data.data);
    bot.sendMessage(
      chatId,
      `Qabul qilindi ✅\n\nIsm: ${data.name || "-"}\nXabar: ${data.message}`
    );
  } catch (err) {
    bot.sendMessage(chatId, "Ma'lumotni o'qishda xatolik yuz berdi.");
  }
});
 
console.log("Bot ishga tushdi...");
 
