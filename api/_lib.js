const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "anadolu_ciftlik_gizli_jwt_2025_degistir_bunu";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function ok(res, data, status = 200) {
  cors(res);
  res.status(status).json({ ok: true, ...data });
}

function err(res, message, status = 400) {
  cors(res);
  res.status(status).json({ ok: false, error: message });
}

function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "").slice(-10);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

async function getUserFromReq(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded || decoded.type !== "user") return null;
  const { data, error } = await supabase.from("users").select("*").eq("id", decoded.id).single();
  if (error || !data) return null;
  return data;
}

async function getAdminFromReq(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded || decoded.type !== "admin") return null;
  return { username: decoded.username };
}

async function ensureFarm(userId) {
  const { data, error } = await supabase.from("farms").select("*").eq("user_id", userId).single();
  if (data) return data;
  // yoksa oluştur
  const { data: newFarm, error: e2 } = await supabase.from("farms").insert({ user_id: userId }).select().single();
  if (e2) throw e2;
  // envanter başlangıç
  const products = ["yumurta", "bal", "sut", "peynir"];
  for (const p of products) {
    await supabase.from("inventory").upsert({ user_id: userId, product: p, amount: 0 }, { onConflict: "user_id,product" });
  }
  // hoş geldin bonusu history
  await supabase.from("history").insert({ user_id: userId, type: "bonus", description: "Hoş geldin bonusu", amount: 150 });
  return newFarm;
}

module.exports = {
  supabase, bcrypt, jwt, JWT_SECRET,
  ADMIN_USER, ADMIN_PASS,
  cors, ok, err, normalizePhone,
  signToken, verifyToken, getUserFromReq, getAdminFromReq, ensureFarm
};