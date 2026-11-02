const { supabase, bcrypt, ok, err, cors, normalizePhone, signToken, getUserFromReq, getAdminFromReq, ensureFarm, ADMIN_USER, ADMIN_PASS, verifyToken } = require("./_lib");

// Sabitler
const ANIMALS = {
  tavuk: { name:"Tavuk", price:150,  monthly:300,   product:"yumurta", feedPerDay:0.2 },
  ari:   { name:"Arı",   price:500,  monthly:1500,  product:"bal",     feedPerDay:0.1 },
  koyun: { name:"Koyun", price:2000, monthly:5000,  product:"sut",     feedPerDay:1 },
  inek:  { name:"İnek",  price:5000, monthly:15000, product:"peynir",  feedPerDay:3 },
};
const SEC_PER_MONTH = 86400 * 30;
const ANIMAL_LIFE_SEC = 86400 * 30;
const BASE_PRICES = { yumurta:2, bal:10, sut:8, peynir:25 };
const FEED_CAP = 1000; // Yem stoğu kapasitesi 1000 olarak güncellendi

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); return res.status(200).end(); }

  // Vercel üzerinden gelen API adresini belirle
  const requestedPath = req.query?.path || req.url.replace(/^\/api/, "").split("?")[0];
  const path = requestedPath === "/" || requestedPath === "" ? "/index" : requestedPath;

  try {
    // ================= AUTH =================
    if (path === "/register" && req.method === "POST") {
      const { name, phone: rawPhone, password, avatar } = req.body || {};
      const phone = normalizePhone(rawPhone);
      if (!name || name.trim().length < 3) return err(res, "Ad soyad en az 3 karakter olmalı");
      if (phone.length !== 10) return err(res, "Geçerli bir telefon girin");
      if (!password || password.length < 4) return err(res, "Şifre en az 4 karakter olmalı");

      const { data: existing } = await supabase.from("users").select("id").eq("phone", phone).single();
      if (existing) return err(res, "Bu telefon numarası zaten kayıtlı");

      const password_hash = await bcrypt.hash(password, 10);
      const { data: user, error } = await supabase.from("users").insert({ name: name.trim(), phone, password_hash, avatar: avatar || "🐄" }).select().single();
      if (error) return err(res, error.message);

      await ensureFarm(user.id);
      const token = signToken({ id: user.id, type: "user", phone: user.phone });
      return ok(res, { token, user: { id: user.id, name: user.name, phone: user.phone, avatar: user.avatar } });
    }

    if (path === "/login" && req.method === "POST") {
      const { phone: rawPhone, password } = req.body || {};
      const phone = normalizePhone(rawPhone);
      if (phone.length !== 10 || !password) return err(res, "Telefon ve şifre gerekli");

      const { data: user, error } = await supabase.from("users").select("*").eq("phone", phone).single();
      if (error || !user) return err(res, "Bu telefon numarası kayıtlı değil");

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return err(res, "Şifre hatalı");

      await ensureFarm(user.id);
      const token = signToken({ id: user.id, type: "user", phone: user.phone });
      return ok(res, { token, user: { id: user.id, name: user.name, phone: user.phone, avatar: user.avatar } });
    }

    if (path === "/admin-login" && req.method === "POST") {
      const { username, password } = req.body || {};
      if (username !== ADMIN_USER || password !== ADMIN_PASS) return err(res, "Kullanıcı adı veya şifre hatalı", 401);
      const token = signToken({ username, type: "admin" });
      return ok(res, { token });
    }

    // ================= KULLANICI İŞLEMLERİ =================
    if (path === "/farm-state" && req.method === "GET") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      let farm = await ensureFarm(user.id);
      farm = await advanceAges(user.id, farm);

      // OTOMATİK YEM KONTROLÜ
      if (farm.auto_feed && Number(farm.feed) < 10) {
        const { data: animalsAuto } = await supabase.from("animals").select("type").eq("user_id", user.id);
        const aliveAuto = { tavuk:0, ari:0, koyun:0, inek:0 };
        (animalsAuto || []).forEach(a => { aliveAuto[a.type]++; });
        
        let dailyNeedAuto = 0;
        for (const k in aliveAuto) dailyNeedAuto += aliveAuto[k] * ANIMALS[k].feedPerDay;
        if (dailyNeedAuto === 0) dailyNeedAuto = 1;

        const priceAuto = Math.max(1, Math.floor(100 / dailyNeedAuto));
        const qtyAuto = Math.ceil(dailyNeedAuto);
        const costAuto = qtyAuto * priceAuto;

        if (Number(farm.wallet) >= costAuto) {
          await supabase.from("farms").update({
            wallet: Number(farm.wallet) - costAuto,
            total_spent: Number(farm.total_spent) + costAuto,
            feed: Number(farm.feed) + qtyAuto,
            feed_bought: Number(farm.feed_bought) + qtyAuto
          }).eq("user_id", user.id);
          
          await supabase.from("history").insert({ 
            user_id: user.id, type: "feed", description: `Otomatik Yem Alımı (${qtyAuto} birim)`, amount: -costAuto 
          });
          
          farm.feed = Number(farm.feed) + qtyAuto;
          farm.wallet = Number(farm.wallet) - costAuto;
        }
      }

      const [animalsRes, inventoryRes, historyRes, loadReqRes, withdrawRes, ticketsRes] = await Promise.all([
        supabase.from("animals").select("*").eq("user_id", user.id),
        supabase.from("inventory").select("*").eq("user_id", user.id),
        supabase.from("history").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
        supabase.from("load_requests").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
        supabase.from("withdraw_requests").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
        supabase.from("support_tickets").select("*, support_replies(*)").eq("user_id", user.id).order("created_at", { ascending: false })
      ]);

           return ok(res, {
        user: { id: user.id, name: user.name, phone: user.phone, avatar: user.avatar, created_at: user.created_at },
        farm: {
          ...farm,
          auto_feed: Boolean(farm.auto_feed) // <-- BU SATIRI EKLE
        },
        animals: animalsRes.data || [], inventory: inventoryRes.data || [],
        history: historyRes.data || [], loadRequests: loadReqRes.data || [],
        withdrawRequests: withdrawRes.data || [], tickets: ticketsRes.data || []
      });
    }

    if (path === "/toggle-auto-feed" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { enable } = req.body || {};
      await supabase.from("farms").update({ auto_feed: enable }).eq("user_id", user.id);
      return ok(res, { message: "Otomatik yem ayarı güncellendi", auto_feed: enable });
    }

    if (path === "/buy-animal" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { type, qty } = req.body || {};
      if (!ANIMALS[type]) return err(res, "Geçersiz hayvan türü");
      const quantity = Math.max(1, parseInt(qty) || 1);
      const cost = ANIMALS[type].price * quantity;
      const farm = await ensureFarm(user.id);

      if (Number(farm.wallet) < cost) return err(res, "Yetersiz bakiye");

      const rows = [];
      for (let i = 0; i < quantity; i++) rows.push({ user_id: user.id, type, age_seconds: 0 });
      await supabase.from("animals").insert(rows);
      await supabase.from("farms").update({ wallet: Number(farm.wallet) - cost, total_spent: Number(farm.total_spent) + cost }).eq("user_id", user.id);
      await supabase.from("history").insert({ user_id: user.id, type: "buy", description: `${quantity} adet ${ANIMALS[type].name} yatırımı`, amount: -cost });

      return ok(res, { message: `${quantity} adet ${ANIMALS[type].name} alındı`, cost });
    }

    if (path === "/sell-product" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { product } = req.body || {};
      if (!BASE_PRICES[product]) return err(res, "Geçersiz ürün");

      const { data: inv } = await supabase.from("inventory").select("amount").eq("user_id", user.id).eq("product", product).single();
      const amount = Number(inv?.amount || 0);
      if (amount <= 0) return err(res, "Satacak ürün yok");

      const earned = amount * BASE_PRICES[product];
      const farm = await ensureFarm(user.id);

      await supabase.from("inventory").update({ amount: 0 }).eq("user_id", user.id).eq("product", product);
      await supabase.from("farms").update({ wallet: Number(farm.wallet) + earned, total_sold: Number(farm.total_sold) + earned }).eq("user_id", user.id);
      await supabase.from("history").insert({ user_id: user.id, type: "sell", description: `${amount.toFixed(2)} ${product} satışı`, amount: earned });

      return ok(res, { message: "Satış yapıldı", earned, amount });
    }

    if (path === "/buy-feed" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { amount } = req.body || {};
      const farm = await ensureFarm(user.id);
      
      const space = FEED_CAP - Number(farm.feed);
      
      // Dinamik fiyat hesaplama: Hayvanların 1 günlük tüketimi * 100 tl
      const { data: animals } = await supabase.from("animals").select("type").eq("user_id", user.id);
      const aliveCounts = { tavuk:0, ari:0, koyun:0, inek:0 };
      (animals || []).forEach(a => { aliveCounts[a.type]++; });
      
      let dailyFeedNeed = 0;
      for (const k in aliveCounts) dailyFeedNeed += aliveCounts[k] * ANIMALS[k].feedPerDay;
      if (dailyFeedNeed === 0) dailyFeedNeed = 1;

      const feedPricePerUnit = Math.max(1, Math.floor(100 / dailyFeedNeed)); 
      
      let qty = parseInt(amount);
      if (isNaN(qty) || qty <= 0) {
        qty = Math.ceil(dailyFeedNeed); 
      }
      
      const realAmount = Math.min(qty, space);
      if (realAmount <= 0) return err(res, "Yem deposu dolu (Kapasite: 1000)");

      const cost = realAmount * feedPricePerUnit;
      if (Number(farm.wallet) < cost) return err(res, "Yetersiz bakiye! Gerekli: " + cost + " ₺");

      await supabase.from("farms").update({ 
        wallet: Number(farm.wallet) - cost, 
        total_spent: Number(farm.total_spent) + cost, 
        feed: Number(farm.feed) + realAmount, 
        feed_bought: Number(farm.feed_bought) + realAmount,
        feed_cap: FEED_CAP
      }).eq("user_id", user.id);
      
      await supabase.from("history").insert({ 
        user_id: user.id, 
        type: "feed", 
        description: `${realAmount} birim yem alımı`, 
        amount: -cost 
      });

      return ok(res, { message: `${realAmount} yem alındı`, cost, price: feedPricePerUnit });
    }

    if (path === "/withdraw" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { amount, bank, iban, name } = req.body || {};
      const amt = parseFloat(amount);
      if (!amt || amt < 500) return err(res, "Minimum çekim 500 ₺");
      if (!bank || !iban || !name) return err(res, "Banka, IBAN ve isim gerekli");

      const farm = await ensureFarm(user.id);
      if (Number(farm.wallet) < amt) return err(res, "Yetersiz bakiye");

      await supabase.from("withdraw_requests").insert({ user_id: user.id, amount: amt, bank, iban, name, status: "pending" });
      await supabase.from("farms").update({ wallet: Number(farm.wallet) - amt, total_withdrawn: Number(farm.total_withdrawn) + amt }).eq("user_id", user.id);

      return ok(res, { message: "Çekim talebi oluşturuldu" });
    }

    if (path === "/load-request" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { amount } = req.body || {};
      const amt = parseFloat(amount);
      if (!amt || amt < 50) return err(res, "Minimum yükleme tutarı 50 ₺");

      const { data, error } = await supabase.from("load_requests").insert({ user_id: user.id, amount: amt, status: "pending" }).select().single();
      if (error) return err(res, error.message);

      return ok(res, { request: data });
    }

    if (path === "/support-ticket" && req.method === "POST") {
      const user = await getUserFromReq(req);
      if (!user) return err(res, "Oturum bulunamadı", 401);

      const { subject, message } = req.body || {};
      if (!subject) return err(res, "Konu seçin");
      if (!message || message.length < 10) return err(res, "Mesaj en az 10 karakter olmalı");

      const { data, error } = await supabase.from("support_tickets").insert({ user_id: user.id, subject, message, status: "pending" }).select().single();
      if (error) return err(res, error.message);

      return ok(res, { ticket: data });
    }

    // ================= ADMIN İŞLEMLERİ =================
    if (path === "/admin-pending" && req.method === "GET") {
      const admin = await getAdminFromReq(req);
      if (!admin) return err(res, "Yetkisiz", 401);

      const [usersRes, farmsRes, loadsRes, withdrawsRes, ticketsRes, animalsRes] = await Promise.all([
        supabase.from("users").select("id, name, phone, avatar, created_at"),
        supabase.from("farms").select("*"),
        supabase.from("load_requests").select("*").order("created_at", { ascending: false }),
        supabase.from("withdraw_requests").select("*").order("created_at", { ascending: false }),
        supabase.from("support_tickets").select("*, support_replies(*)").order("created_at", { ascending: false }),
        supabase.from("animals").select("user_id, type, age_seconds")
      ]);

      const users = usersRes.data || [], farms = farmsRes.data || [];
      const userMap = {}, farmMap = {};
      users.forEach(u => { userMap[u.id] = u; });
      farms.forEach(f => { farmMap[f.user_id] = f; });

      const animalMap = {};
      (animalsRes.data || []).forEach(a => {
        if (!animalMap[a.user_id]) animalMap[a.user_id] = { total: 0, alive: 0 };
        animalMap[a.user_id].total++;
        if (Number(a.age_seconds) < ANIMAL_LIFE_SEC) animalMap[a.user_id].alive++;
      });

      const enrichedUsers = users.map(u => ({ ...u, farm: farmMap[u.id] || null, animals: animalMap[u.id] || { total: 0, alive: 0 } }));
      const enrichedLoads = (loadsRes.data || []).map(l => ({ ...l, user: userMap[l.user_id] || null, type: "load" }));
      const enrichedWithdraws = (withdrawsRes.data || []).map(w => ({ ...w, user: userMap[w.user_id] || null, type: "withdraw" }));
      const enrichedTickets = (ticketsRes.data || []).map(t => ({ ...t, user: userMap[t.user_id] || null }));

      return ok(res, { users: enrichedUsers, loads: enrichedLoads, withdraws: enrichedWithdraws, tickets: enrichedTickets });
    }

    if (path === "/admin-approve" && req.method === "POST") {
      const admin = await getAdminFromReq(req);
      if (!admin) return err(res, "Yetkisiz", 401);

      const { type, id } = req.body || {};
      if (!id || (type !== "load" && type !== "withdraw")) return err(res, "Geçersiz istek");

      if (type === "load") {
        const { data: lr } = await supabase.from("load_requests").select("*").eq("id", id).single();
        if (!lr || lr.status !== "pending") return err(res, "Talep bulunamadı veya işlenmiş");
        await supabase.from("load_requests").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", id);
        const { data: farm } = await supabase.from("farms").select("*").eq("user_id", lr.user_id).single();
        await supabase.from("farms").update({ wallet: Number(farm.wallet) + Number(lr.amount), total_loaded: Number(farm.total_loaded) + Number(lr.amount) }).eq("user_id", lr.user_id);
        await supabase.from("history").insert({ user_id: lr.user_id, type: "load", description: "Bakiye yükleme (Admin onaylı)", amount: lr.amount });
      } else {
        const { data: wr } = await supabase.from("withdraw_requests").select("*").eq("id", id).single();
        if (!wr || wr.status !== "pending") return err(res, "Talep bulunamadı veya işlenmiş");
        await supabase.from("withdraw_requests").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", id);
        await supabase.from("history").insert({ user_id: wr.user_id, type: "withdraw", description: "Banka hesabına para çekme (Onaylı)", amount: -wr.amount });
      }
      return ok(res, { message: "Onaylandı" });
    }

    if (path === "/admin-reject" && req.method === "POST") {
      const admin = await getAdminFromReq(req);
      if (!admin) return err(res, "Yetkisiz", 401);

      const { type, id, reason } = req.body || {};
      if (!id || (type !== "load" && type !== "withdraw")) return err(res, "Geçersiz istek");
      const rejectReason = reason || "Admin reddi";

      if (type === "load") {
        await supabase.from("load_requests").update({ status: "rejected", reject_reason: rejectReason }).eq("id", id);
      } else {
        const { data: wr } = await supabase.from("withdraw_requests").select("*").eq("id", id).single();
        if (wr) {
          const { data: farm } = await supabase.from("farms").select("*").eq("user_id", wr.user_id).single();
          await supabase.from("farms").update({ wallet: Number(farm.wallet) + Number(wr.amount), total_withdrawn: Number(farm.total_withdrawn) - Number(wr.amount) }).eq("user_id", wr.user_id);
          await supabase.from("withdraw_requests").update({ status: "rejected", reject_reason: rejectReason }).eq("id", id);
          await supabase.from("history").insert({ user_id: wr.user_id, type: "withdraw_reject", description: `Çekim reddedildi: ${rejectReason}`, amount: wr.amount });
        }
      }
      return ok(res, { message: "Reddedildi" });
    }

    if (path === "/admin-support-reply" && req.method === "POST") {
      const admin = await getAdminFromReq(req);
      if (!admin) return err(res, "Yetkisiz", 401);

      const { ticket_id, message } = req.body || {};
      if (!ticket_id || !message) return err(res, "Eksik bilgi");

      await supabase.from("support_replies").insert({ ticket_id, message, by_admin: true });
      await supabase.from("support_tickets").update({ status: "answered" }).eq("id", ticket_id);

      return ok(res, { message: "Cevap gönderildi" });
    }

    // Eşleşen rota yoksa
    return err(res, "Endpoint bulunamadı: " + path, 404);

  } catch (e) {
    console.error("API Hatası:", e);
    return err(res, "Sunucu hatası: " + e.message, 500);
  }
};

// Hayvan yaşlandırma ve üretim fonksiyonu
async function advanceAges(userId, farm) {
  const now = new Date();
  const lastTick = new Date(farm.last_tick);
  const deltaSec = Math.max(0, (now - lastTick) / 1000);
  if (deltaSec <= 0) return farm;

  const { data: animals } = await supabase.from("animals").select("*").eq("user_id", userId);
  const animalRows = animals || [];
  if (animalRows.length > 0) {
    const updates = animalRows.map(a => supabase.from("animals").update({ age_seconds: Number(a.age_seconds) + deltaSec }).eq("id", a.id));
    await Promise.all(updates);
  }

  const aliveCounts = { tavuk:0, ari:0, koyun:0, inek:0 };
  animalRows.forEach(a => { if (Number(a.age_seconds) + deltaSec < ANIMAL_LIFE_SEC) aliveCounts[a.type]++; });
  const feedFactor = Number(farm.feed) > 0 ? 1 : 0;

  for (const key in ANIMALS) {
    if (aliveCounts[key] > 0 && feedFactor > 0) {
      const animal = ANIMALS[key];
      const perSec = animal.monthly / SEC_PER_MONTH;
      const secUnits = perSec / BASE_PRICES[animal.product];
      const inc = secUnits * deltaSec * aliveCounts[key];
      if (inc > 0) {
        const { data: inv } = await supabase.from("inventory").select("amount").eq("user_id", userId).eq("product", animal.product).single();
        if (inv) {
          await supabase.from("inventory").update({ amount: Number(inv.amount) + inc }).eq("user_id", userId).eq("product", animal.product);
        }
      }
    }
  }

  let feedNeed = 0;
  for (const k in aliveCounts) feedNeed += aliveCounts[k] * ANIMALS[k].feedPerDay;
  const daysPassed = deltaSec / 86400;
  const feedUsed = feedNeed * daysPassed;
  const realUsed = Math.min(feedUsed, Number(farm.feed));
  const newFeed = Math.max(0, Number(farm.feed) - realUsed);

  await supabase.from("farms").update({ feed: newFeed, feed_used: Number(farm.feed_used) + realUsed, last_tick: now.toISOString() }).eq("user_id", userId);

  return { ...farm, feed: newFeed, last_tick: now.toISOString() };
}
