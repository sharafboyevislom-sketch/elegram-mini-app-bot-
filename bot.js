// Telegram bot:
// - Mijozlar uchun: /start -> ism, telefon so'raydi -> Mini App tugmasi
// - Haydovchilar uchun: /haydovchi -> ism, telefon, mashina ma'lumoti so'raydi -> Haydovchi paneli tugmasi
// - Yangi ovqat buyurtmasi -> tegishli do'kon guruhiga xabar
// - Yangi taksi so'rovi -> BARCHA onlayn haydovchilarga SHAXSIY xabar (guruhsiz)
//
// Railway Variables: BOT_TOKEN, WEBAPP_URL, DRIVER_APP_URL, SUPABASE_URL, SUPABASE_KEY,
//                     GROUP_CHAT_ID (ixtiyoriy), WEBHOOK_SECRET (ixtiyoriy)

require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const DRIVER_APP_URL = process.env.DRIVER_APP_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // ixtiyoriy fallback (ovqat buyurtmalari uchun)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN || !WEBAPP_URL || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("BOT_TOKEN, WEBAPP_URL, SUPABASE_URL, SUPABASE_KEY hammasi kerak.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Har bir chat uchun vaqtinchalik holat: { role: 'customer'|'driver', step, ...yig'ilgan ma'lumot }
const pendingState = new Map();

function openAppKeyboard(telegramId) {
  const url = `${WEBAPP_URL}?tid=${telegramId}`;
  return {
    reply_markup: {
      keyboard: [[{ text: "🚀 Ilovani ochish", web_app: { url } }]],
      resize_keyboard: true,
    },
  };
}

function driverAppKeyboard(telegramId) {
  const url = `${DRIVER_APP_URL}?tid=${telegramId}`;
  return {
    reply_markup: {
      keyboard: [[{ text: "🚗 Haydovchi paneli", web_app: { url } }]],
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

// ==== Mijoz oqimi ====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

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

  pendingState.set(chatId, { role: "customer", step: "name" });
  bot.sendMessage(chatId, "Assalomu alaykum! Ismingizni kiriting:");
});

// ==== Haydovchi oqimi ====
bot.onText(/\/haydovchi/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  if (msg.chat.type !== "private") return;

  const { data: existing } = await supabase
    .from("drivers")
    .select("id, full_name")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (existing) {
    bot.sendMessage(
      chatId,
      `Xush kelibsiz, ${existing.full_name}! Haydovchi panelini oching 👇`,
      driverAppKeyboard(telegramId)
    );
    return;
  }

  pendingState.set(chatId, { role: "driver", step: "name" });
  bot.sendMessage(chatId, "Haydovchi sifatida ro'yxatdan o'tish. Ismingizni kiriting:");
});

bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const state = pendingState.get(chatId);
  if (!state) return;
  const telegramId = msg.from.id;
  const phone = msg.contact.phone_number;

  if (state.role === "customer" && state.step === "phone") {
    await supabase.from("customers").upsert(
      { telegram_id: telegramId, full_name: state.name, phone },
      { onConflict: "telegram_id" }
    );
    pendingState.delete(chatId);
    bot.sendMessage(chatId, "Rahmat! Endi buyurtma berishingiz mumkin 👇", openAppKeyboard(telegramId));
    return;
  }

  if (state.role === "driver" && state.step === "phone") {
    pendingState.set(chatId, { ...state, step: "car_model", phone });
    bot.sendMessage(chatId, "Mashinangiz modelini kiriting (masalan: Chevrolet Cobalt):");
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const state = pendingState.get(chatId);
  if (!state) return;
  if (msg.text && msg.text.startsWith("/")) return;
  if (msg.contact) return;

  const text = (msg.text || "").trim();

  // ---- Mijoz ----
  if (state.role === "customer" && state.step === "name") {
    if (!text) {
      bot.sendMessage(chatId, "Iltimos, ismingizni matn sifatida yozing.");
      return;
    }
    pendingState.set(chatId, { role: "customer", step: "phone", name: text });
    bot.sendMessage(chatId, `Rahmat, ${text}! Endi telefon raqamingizni yuboring:`, contactKeyboard());
    return;
  }

  // ---- Haydovchi ----
  if (state.role === "driver") {
    if (state.step === "name") {
      if (!text) {
        bot.sendMessage(chatId, "Iltimos, ismingizni matn sifatida yozing.");
        return;
      }
      pendingState.set(chatId, { ...state, step: "phone", name: text });
      bot.sendMessage(chatId, `Rahmat, ${text}! Endi telefon raqamingizni yuboring:`, contactKeyboard());
      return;
    }
    if (state.step === "car_model") {
      if (!text) {
        bot.sendMessage(chatId, "Iltimos, mashina modelini yozing.");
        return;
      }
      pendingState.set(chatId, { ...state, step: "car_plate", car_model: text });
      bot.sendMessage(chatId, "Davlat raqamini kiriting (masalan: 01A123BC):");
      return;
    }
    if (state.step === "car_plate") {
      if (!text) {
        bot.sendMessage(chatId, "Iltimos, davlat raqamini yozing.");
        return;
      }
      const telegramId = msg.from.id;
      await supabase.from("drivers").upsert(
        {
          telegram_id: telegramId,
          full_name: state.name,
          phone: state.phone,
          car_model: state.car_model,
          car_plate: text,
        },
        { onConflict: "telegram_id" }
      );
      pendingState.delete(chatId);
      bot.sendMessage(
        chatId,
        "Ro'yxatdan o'tdingiz! Haydovchi panelida onlayn bo'lib, buyurtmalarni qabul qilishingiz mumkin 👇",
        driverAppKeyboard(telegramId)
      );
      return;
    }
  }
});

console.log("Bot ishga tushdi...");

// ==== HTTP server ====
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

function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) return true;
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    res.status(401).send("Ruxsat yo'q");
    return false;
  }
  return true;
}

// ---- Yangi ovqat/mahsulot buyurtmasi -> do'kon guruhiga ----
app.post("/webhook/new-order", async (req, res) => {
  if (!checkSecret(req, res)) return;

  try {
    const order = req.body.record;

    const { data: business } = await supabase
      .from("businesses")
      .select("name, group_chat_id")
      .eq("id", order.business_id)
      .maybeSingle();

    const targetChatId = business?.group_chat_id || GROUP_CHAT_ID;
    if (!targetChatId) {
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

// ---- Yangi taksi so'rovi -> barcha onlayn haydovchilarga shaxsiy xabar ----
app.post("/webhook/new-taxi-order", async (req, res) => {
  if (!checkSecret(req, res)) return;

  try {
    const order = req.body.record;

    const { data: onlineDrivers } = await supabase
      .from("drivers")
      .select("telegram_id")
      .eq("is_active", true)
      .eq("is_online", true);

    if (!onlineDrivers || onlineDrivers.length === 0) {
      console.log("Onlayn haydovchi topilmadi.");
      return res.status(200).send("OK (haydovchi yo'q)");
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("full_name, phone")
      .eq("id", order.customer_id)
      .maybeSingle();

    const mapLink = `https://maps.google.com/?q=${order.pickup_latitude},${order.pickup_longitude}`;
    const isDelivery = order.service_type === "delivery";
    const text =
      `${isDelivery ? "📦 Yangi dostavka so'rovi!" : "🚖 Yangi taksi so'rovi!"}\n\n` +
      `👤 ${customer?.full_name || "Noma'lum"}\n` +
      `📞 ${customer?.phone || "—"}\n\n` +
      (isDelivery && order.parcel_description ? `📦 Nima: ${order.parcel_description}\n` : "") +
      `📍 ${mapLink}\n` +
      `🏁 Qayerga: ${order.destination_text || "—"}\n\n` +
      `Qabul qilish uchun haydovchi panelini oching.`;

    await Promise.all(
      onlineDrivers.map((d) =>
        bot.sendMessage(d.telegram_id, text, {
          reply_markup: {
            inline_keyboard: [[{ text: "🚗 Haydovchi panelini ochish", web_app: { url: `${DRIVER_APP_URL}?tid=${d.telegram_id}` } }]],
          },
        }).catch((e) => console.log("Haydovchiga yuborilmadi:", d.telegram_id, e.message))
      )
    );

    res.status(200).send("OK");
  } catch (err) {
    console.error("Taksi webhook xatosi:", err);
    res.status(500).send("Xatolik");
  }
});

// ---- Haydovchi buyurtmani qabul qilgach -> mijozga shaxsiy xabar ----
app.post("/webhook/taxi-accepted", async (req, res) => {
  if (!checkSecret(req, res)) return;

  try {
    const { order_id } = req.body;

    const { data: order } = await supabase
      .from("taxi_orders")
      .select("*, customers(telegram_id), drivers(full_name, phone, car_model, car_plate)")
      .eq("id", order_id)
      .maybeSingle();

    if (!order) return res.status(404).send("Topilmadi");

    const customerTelegramId = order.customers?.telegram_id;
    const driver = order.drivers;

    if (customerTelegramId && driver) {
      await bot.sendMessage(
        customerTelegramId,
        `🚖 Haydovchi topildi!\n\n👤 ${driver.full_name}\n📞 ${driver.phone || "—"}\n🚗 ${driver.car_model || "—"} (${driver.car_plate || "—"})`
      );
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("taxi-accepted xatosi:", err);
    res.status(500).send("Xatolik");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda ishlayapti`));
// ==== Faza 4/6/7/8 — yangi modullarni ulash ====
const { registerOrderFlowHandlers, notifyRestaurantGroup } = require('./faza4_buyurtma_holati_va_guruh');
const { registerCourierAssignmentHandlers, registerRatingHandler, askForRating } = require('./faza6_kuryer_biriktirish_va_baho');
const initSettlementCron = require('./faza7_hisobkitob_cron');
const { registerGroupOfferHandlers } = require('./faza8_guruh_marketing');
const initGroupMarketing = require('./faza8_guruh_marketing');

registerOrderFlowHandlers(bot);
registerCourierAssignmentHandlers(bot);
registerRatingHandler(bot);
registerGroupOfferHandlers(bot);
initSettlementCron(bot);
initGroupMarketing(bot);
