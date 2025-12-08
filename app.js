// server.js - Smart Locker Backend + Mongoose + Auth Customer
// Implements One-Time Token System for Locker Access
require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

// ==================================================
// API TIMING MIDDLEWARE (for thesis debug)
// ==================================================
app.use((req, res, next) => {
  const startTime = Date.now();
  const startDate = new Date().toISOString();
  
  // Log when request is received
  console.log(`[API IN] ${req.method} ${req.path} - Received at ${startDate}`);
  
  // Override res.json to capture response time
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    const endDate = new Date().toISOString();
    
    console.log(`[API OUT] ${req.method} ${req.path} - Status ${res.statusCode} - Duration: ${duration}ms - Sent at ${endDate}`);
    
    return originalJson(data);
  };
  
  // Also capture non-JSON responses
  const originalSend = res.send.bind(res);
  res.send = function(data) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    const endDate = new Date().toISOString();
    
    console.log(`[API OUT] ${req.method} ${req.path} - Status ${res.statusCode} - Duration: ${duration}ms - Sent at ${endDate}`);
    
    return originalSend(data);
  };
  
  next();
});

// Configure axios defaults for better timeout handling
axios.defaults.timeout = 30000; // 30 seconds default
axios.defaults.headers.common['User-Agent'] = 'Smart-Locker-Backend/1.0';

// === ENV ===
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/smartlocker";
const BINDER_KEY = process.env. BINDERBYTE_API_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "supersecret-key-for-dev";

// === KONEKSI MONGODB ===
mongoose
  .connect(MONGO_URI)
  .then(() => console. log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const { Schema, model } = mongoose;

// ==================================================
// MODELS
// ==================================================

/**
 * USER (customer / agent)
 * - koleksi: customer_users
 */
const userSchema = new Schema(
  {
    userId: { type: String, unique: true },
    name: String,
    email: { type: String, unique: true, sparse: true },
    phone: String,
    passwordHash: String,
    role: { type: String, default: "customer" }, // customer / agent / admin
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
const User = model("User", userSchema, "customer_users");

/**
 * Shipment (paket per resi)
 * OPTIMIZED: Removed per-resi token - using only lockerToken for access
 */
const shipmentSchema = new Schema(
  {
    resi: { type: String, required: true },
    lockerId: { type: String, required: true },
    courierType: { type: String, required: true },

    receiverName: { type: String },
    receiverPhone: { type: String },
    customerId: { type: String },
    itemType: { type: String },

    courierId: { type: String },
    courierPlate: { type: String },
    courierName: { type: String },

    status: { type: String, default: "assigned_to_locker" },
    createdAt: { type: Date, default: Date.now },

    logs: {
      type: [
        {
          event: String,
          lockerId: String,
          resi: String,
          timestamp: Date,
          extra: Schema.Types.Mixed,
        },
      ],
      default: [],
    },

    deliveredToLockerAt: { type: Date },
    deliveredToCustomerAt: { type: Date },
    pickedUpAt: { type: Date },
  },
  { versionKey: false }
);
const Shipment = model("Shipment", shipmentSchema, "shipments");

/**
 * Locker (per kotak fisik)
 * Updated with courierHistory for one-time token tracking
 * OPTIMIZED: Removed pendingShipments token pool - using simpler pendingResi
 */
const lockerSchema = new Schema(
  {
    lockerId: { type: String, required: true, unique: true },
    lockerToken: { type: String, default: null },

    // Track all couriers who delivered here
    courierHistory: {
      type: [
        {
          courierId: String,
          courierName: String,
          courierPlate: String,
          resi: String,
          deliveredAt: Date,
          usedToken: String,
        },
      ],
      default: [],
    },

    // 🔍 DEBUG info untuk pengujian waktu respon
    debugInfo: {
      type: {
        enabled: { type: Boolean, default: false },
        resi: String,
        scanAtClient: Date,   // waktu di app kurir (opsional)
        scanAtBackend: Date,  // waktu request masuk backend
        commandSentAt: Date,  // waktu ESP ambil command
        espLogAt: Date,       // waktu ESP kirim log "locker_opened"
        lastEvent: String,
      },
      default: null,
    },

    // List of pending resi numbers for this locker
    pendingResi: { type: [String], default: [] },

    command: { type: Schema.Types.Mixed, default: null },

    // ON/OFF manual oleh agent
    isActive: { type: Boolean, default: true },

    // status heartbeat: "online" / "offline" / "unknown"
    status: { type: String, default: "unknown" },

    tokenUpdatedAt: { type: Date },
    lastHeartbeat: { type: Date },
  },
  { collection: "lockers" }
);
const Locker = model("Locker", lockerSchema);

/**
 * LockerLog (optional, audit trail)
 */
const lockerLogSchema = new Schema(
  {
    lockerId: String,
    resi: String,
    action: String,
    at: { type: Date, default: Date. now },
  },
  { versionKey: false }
);
const LockerLog = model("LockerLog", lockerLogSchema, "locker_logs");

/**
 * Customer manual tracking (user input resi di app)
 */
const customerTrackingSchema = new Schema(
  {
    resi: { type: String, required: true },
    courierType: { type: String },
    customerId: { type: String },
    note: { type: String },
    validated: { type: Boolean, default: false },
    validationAttempted: { type: Boolean, default: false },
    binderbyteData: {
      summary: { type: Object },
      validatedAt: { type: Date }
    }
  },
  {
    collection: "customer_trackings",
    timestamps: true,
  }
);
const CustomerTracking = model(
  "CustomerTracking",
  customerTrackingSchema,
  "customer_trackings"
);

/**
 * Courier (kurir)
 */
const courierSchema = new Schema(
  {
    courierId: { type: String, unique: true }, // CR-ANT-xxx
    name: { type: String, required: true },
    company: { type: String, required: true }, // anteraja, jne, jnt, dll
    plate: { type: String, required: true }, // uppercased
    phone: { type: String },
    passwordHash: { type: String },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    collection: "couriers",
    timestamps: true, // Keep createdAt/updatedAt for reference
  }
);
const Courier = model("Courier", courierSchema);

// ==================================================
// HELPERS
// ==================================================

// Helper: generate cryptographically secure random token
function randomToken(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

// Helper: generate 6-digit customerId (userId)
function generateCustomerId() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 100000 - 999999
}

// Helper: dapat locker dari Mongo, auto-create jika belum ada
async function getLocker(lockerId) {
  let locker = await Locker. findOne({ lockerId });
  if (!locker) {
    locker = await Locker. create({
      lockerId,
      lockerToken: randomToken(`LK-${lockerId}`),
      pendingResi: [],
      courierHistory: [],
      command: null,
      isActive: true,
      status: "unknown",
    });
  }
  return locker;
}

// Helper: recalculate courier state based on shipments
async function recalcCourierState(courierId) {
  const courier = await Courier.findOne({ courierId });
  if (!courier) return;

  // No automatic status changes
  // Status only changed manually by agent via API
  // Just update timestamps if needed
  console.log(`[COURIER] ${courierId} status: ${courier.status}`);
}

// Helper: send notification to customer (placeholder - implement with FCM/push service)
async function sendNotificationToCustomer(userId, title, message, data = {}) {
  // TODO: Implement with Firebase Cloud Messaging or other push notification service
  console.log(`[NOTIFICATION] To customer ${userId}: ${title} - ${message}`, data);
  // For now, just log. In production, send via FCM/OneSignal/etc.
  return Promise.resolve();
}

// 🔍 Helper: Log debug phases for QR scan timing analysis (thesis)
function pushDebugPhase(locker, phase, extra = {}) {
  if (!locker) return;
  if (!locker.debugInfo) locker.debugInfo = { enabled: false };

  const now = new Date();

  if (phase === "scan") {
    locker.debugInfo.enabled = true;
    locker.debugInfo.scanAtBackend = now;
  } else if (phase === "command") {
    locker.debugInfo.commandSentAt = now;
  } else if (phase === "esp_log") {
    locker.debugInfo.espLogAt = now;
  }

  locker.debugInfo.lastEvent = phase;
  Object.assign(locker.debugInfo, extra);

  console.log(
    `[DEBUG-QR] phase=${phase} locker=${locker.lockerId} resi=${locker.debugInfo.resi || "-"} info=`,
    locker.debugInfo
  );
}

// Auth middleware (JWT)
function auth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: "Token missing" });

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Courier Auth Middleware (JWT for couriers)
function authCourier(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: "Token missing" });

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.courierId) {
      return res.status(401).json({ error: "Invalid courier token" });
    }

    req.courier = decoded; // { courierId, plate, company }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ==================================================
// RESI VALIDATION HELPERS
// ==================================================

/**
 * Sanitize resi number - remove spaces, special chars, convert to uppercase
 */
function sanitizeResi(resi) {
  if (!resi || typeof resi !== 'string') return null;

  // Remove all whitespace and convert to uppercase
  const cleaned = resi.trim().replace(/\s+/g, '').toUpperCase();

  // Must be at least 8 characters and alphanumeric
  if (cleaned.length < 8 || !/^[A-Z0-9]+$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Validate resi format and detect courier type
 */
function validateResi(resi) {
  if (!resi || resi.length < 8) {
    return {
      valid: false,
      reason: 'Nomor resi terlalu pendek (minimal 8 karakter)'
    };
  }

  // JNE: starts with JNE or CGK, 10-15 chars
  if (/^(JNE|CGK)[A-Z0-9]{7,12}$/i.test(resi)) {
    return { valid: true, courierType: 'jne' };
  }

  // J&T: starts with JT, 12-16 digits
  if (/^JT\d{10,14}$/i.test(resi)) {
    return { valid: true, courierType: 'jnt' };
  }

  // AnterAja: 10-15 alphanumeric
  if (/^[A-Z0-9]{10,15}$/i.test(resi) && resi.length >= 10) {
    return { valid: true, courierType: 'anteraja' };
  }

  // SiCepat: typically 12 digits
  if (/^\d{12}$/i.test(resi)) {
    return { valid: true, courierType: 'sicepat' };
  }

  // Ninja Express: starts with NLIDAP or numeric
  if (/^(NLIDAP|NV)\d{8,12}$/i.test(resi)) {
    return { valid: true, courierType: 'ninja' };
  }

  // POS Indonesia: various formats
  if (/^[A-Z]{2}\d{9}ID$/i.test(resi) || /^\d{13}$/i.test(resi)) {
    return { valid: true, courierType: 'pos' };
  }

  // Default: try JNE if alphanumeric
  if (/^[A-Z0-9]{10,}$/i.test(resi)) {
    return { valid: true, courierType: 'jne' };
  }

  return {
    valid: false,
    reason: 'Format resi tidak dikenali. Pastikan nomor resi benar.'
  };
}

// ==================================================
// ROUTES
// ==================================================

// 0. Health check
app.get("/", (req, res) => {
  res.send("Smart Locker backend with MongoDB is running ✅");
});

// ---------------------- AUTH (Customer) ----------------------

// Register customer
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email dan password wajib diisi" });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "Email sudah terdaftar" });
    }

    const hash = await bcrypt.hash(password, 10);

    const user = await User.create({
      userId: generateCustomerId(), // 6 digit random
      name,
      email,
      phone,
      passwordHash: hash,
      role: "customer",
    });

    res.json({ message: "Registrasi berhasil", userId: user.userId });
  } catch (err) {
    console.error("POST /api/auth/register error:", err);
    res.status(500).json({ error: "Gagal registrasi" });
  }
});

// Login customer
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user)
      return res.status(404).json({ error: "Email tidak ditemukan" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ error: "Password salah" });

    const token = jwt.sign(
      { userId: user.userId, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login sukses",
      token,
      userId: user.userId,
      name: user.name,
    });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    res.status(500).json({ error: "Gagal login" });
  }
});

// ---------------------- AGENT: Shipments ----------------------

// Agent input paket (bisa banyak resi sekaligus)
app.post("/api/shipments", async (req, res) => {
  try {
    const {
      lockerId,
      courierType,
      resiList,
      receiverName,
      receiverPhone,
      customerId,
      itemType,
      courierPlate,
      courierLabel,
      courierId,
    } = req.body;

    if (! lockerId || !courierType || !Array.isArray(resiList) || resiList.length === 0) {
      return res
        .status(400)
        .json({ error: "lockerId, courierType, resiList wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    // coba ambil nama kurir dari koleksi Courier jika courierId dikirim
    let courierName = courierLabel || "";
    let courier = null;
    if (courierId) {
      courier = await Courier. findOne({ courierId });
      if (!courier) {
        return res.status(404).json({ error: "Courier not found" });
      }
      if (courier.status !== "active") {
        return res
          .status(400)
          .json({ error: `Courier ${courierId} not available (status=${courier.status})` });
      }
      courierName = courier.name;
    }

    const createdShipments = [];

    for (const resi of resiList) {
      const normalizedResi = String(resi).trim();

      // Cek shipment existing
      let sh = await Shipment.findOne({ resi: normalizedResi });

      if (sh) {
        // Masukkan ke pendingResi kalau belum ada
        if (
          !locker.pendingResi.includes(normalizedResi) &&
          sh.status !== "completed" &&
          sh.status !== "delivered_to_locker"
        ) {
          locker.pendingResi. push(normalizedResi);
        }

        createdShipments.push(sh);
        continue;
      }

      // Shipment BARU - simplified without per-resi token
      sh = await Shipment.create({
        resi: normalizedResi,
        courierType,
        lockerId,
        courierId: courierId || "",
        receiverName: receiverName || "Customer Demo",
        receiverPhone: receiverPhone || "",
        customerId: customerId || "",
        itemType: itemType || "",
        courierPlate: courierPlate
          ? courierPlate.trim(). toUpperCase()
          : courier
          ? courier.plate
          : "",
        courierName: courierName || "",
        status: "pending_locker",
        createdAt: new Date(),
        logs: [
          {
            event: "assigned_to_locker",
            lockerId,
            resi: normalizedResi,
            timestamp: new Date(),
            extra: { source: "agent" },
          },
        ],
      });

      createdShipments.push(sh);

      if (! locker.pendingResi. includes(normalizedResi)) {
        locker.pendingResi.push(normalizedResi);
      }
    }

    await locker.save();

    return res.json({
      message: "Shipments assigned to locker",
      locker,
      shipments: createdShipments,
    });
  } catch (err) {
    console.error("POST /api/shipments error:", err);
    return res. status(500).json({ error: "Internal server error" });
  }
});

// List semua shipments (untuk Agent dashboard)
app.get("/api/shipments", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100", 10);

    const shipments = await Shipment.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ data: shipments });
  } catch (err) {
    console. error("GET /api/shipments error:", err);
    res. status(500).json({ error: "Gagal mengambil data shipments" });
  }
});

// SANITASI: hapus shipment
app.delete("/api/shipments/:id", async (req, res) => {
  try {
    const { id } = req. params;
    await Shipment.findByIdAndDelete(id);
    res. json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/shipments/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Validasi resi via Binderbyte (untuk Agent)
app.get("/api/validate-resi", async (req, res) => {
  try {
    const { courier, resi } = req.query;

    if (!courier || !resi) {
      return res
        .status(400)
        .json({ valid: false, error: "courier dan resi wajib diisi" });
    }

    if (! BINDER_KEY) {
      return res. status(500).json({
        valid: false,
        error: "BINDERBYTE_API_KEY belum dikonfigurasi",
      });
    }

    const url = "https://api.binderbyte. com/v1/track";
    const response = await axios.get(url, {
      params: {
        api_key: BINDER_KEY,
        courier,
        awb: resi,
      },
    });

    return res.json({
      valid: true,
      data: response.data,
    });
  } catch (err) {
    console. error("validate-resi error:", err. response?.data || err.message);

    const status = err.response?.status || 500;
    if (status === 400 || status === 404) {
      return res.json({
        valid: false,
        error: "Resi tidak ditemukan atau tidak valid",
      });
    }

    return res.status(500).json({
      valid: false,
      error: "Gagal menghubungi layanan tracking",
    });
  }
});

// ---------------------- CUSTOMER ENDPOINTS ----------------------

// ==================== CUSTOMER: Input Resi Manual (BINDERBYTE DIRECT VALIDATION) ====================
app.post("/api/customer/manual-resi", auth, async (req, res) => {
  try {
    const { resi } = req.body;
    const userId = req.user.userId;

    if (!resi || !resi.trim()) {
      return res.status(400).json({ error: "Nomor resi wajib diisi" });
    }

    const cleanResi = resi.trim().toUpperCase();
    console.log(`[RESI INPUT] Customer ${userId}: "${cleanResi}"`);

    // ✅ STEP 1: CHECK IF ALREADY EXISTS
    const existing = await CustomerTracking.findOne({
      resi: cleanResi,
      customerId: userId
    });

    if (existing) {
      return res.status(400).json({
        error: "Resi ini sudah pernah Anda input sebelumnya",
        resi: cleanResi,
        inputDate: existing.createdAt
      });
    }

    // ✅ STEP 2: CHECK BINDERBYTE API KEY
    if (!BINDER_KEY) {
      console.error('[RESI ERROR] BINDERBYTE_API_KEY not configured!');
      return res.status(503).json({
        error: "Layanan validasi resi sedang tidak tersedia",
        message: "Silakan coba lagi nanti"
      });
    }

    // ✅ STEP 3: TRY ALL COURIERS WITH BINDERBYTE
    console.log(`[BINDERBYTE] Validating ${cleanResi} - trying all couriers...`);

    const couriers = ['jne', 'jnt', 'anteraja', 'sicepat', 'ninja', 'pos'];
    const validationStart = Date.now();
    let binderbyteResult = null;
    let validCourier = null;

    for (const courier of couriers) {
      try {
        console.log(`[BINDERBYTE] Trying ${courier}...`);

        const response = await axios.get("https://api.binderbyte.com/v1/track", {
          params: {
            api_key: BINDER_KEY,
            courier: courier,
            awb: cleanResi,
          },
          timeout: 8000,
        });

        if (response.data?.status === 200 && response.data.data?.summary) {
          binderbyteResult = response.data.data;
          validCourier = courier;

          const validationTime = Date.now() - validationStart;
          console.log(`[BINDERBYTE] ✅ FOUND: ${cleanResi} via ${courier.toUpperCase()} (${validationTime}ms)`);
          break;
        }

      } catch (err) {
        // Continue to next courier
        if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
          console.log(`[BINDERBYTE] ${courier}: Timeout`);
        } else if (err.response?.status === 404) {
          console.log(`[BINDERBYTE] ${courier}: Not found`);
        } else {
          console.log(`[BINDERBYTE] ${courier}: ${err.message}`);
        }
        continue;
      }
    }

    const totalTime = Date.now() - validationStart;

    // ✅ STEP 4: IF NOT FOUND IN ANY COURIER, REJECT
    if (!binderbyteResult || !validCourier) {
      console.error(`[BINDERBYTE] ❌ REJECTED: ${cleanResi} - not found in any courier (${totalTime}ms)`);

      return res.status(404).json({
        error: "Nomor resi tidak ditemukan",
        resi: cleanResi,
        message: "Resi tidak ditemukan di sistem ekspedisi manapun. Pastikan nomor resi sudah benar dan paket sudah di-pickup kurir.",
        suggestion: "Periksa kembali nomor resi atau coba lagi nanti jika paket baru di-pickup"
      });
    }

    // ✅ STEP 5: SAVE TO DATABASE (only valid resi)
    const tracking = await CustomerTracking.create({
      resi: cleanResi,
      courierType: validCourier,
      customerId: userId,
      note: `✅ Validated by Binderbyte`,
      validated: true,
      validationAttempted: true,
      binderbyteData: {
        summary: binderbyteResult.summary,
        validatedAt: new Date()
      }
    });

    console.log(`[RESI SAVED] ✅ ${cleanResi} for customer ${userId} via ${validCourier.toUpperCase()}`);

    // ✅ STEP 6: SEND NOTIFICATION
    try {
      await sendNotificationToCustomer(
        userId,
        '✅ Resi Berhasil Ditambahkan',
        `Paket ${cleanResi} berhasil dilacak via ${validCourier.toUpperCase()}`,
        {
          type: 'resi_added',
          resi: cleanResi,
          courierType: validCourier,
          status: binderbyteResult.summary?.status || 'unknown'
        }
      );
    } catch (notifErr) {
      console.error('[NOTIFICATION] Failed:', notifErr.message);
    }

    // ✅ STEP 7: RETURN SUCCESS WITH TRACKING DATA
    return res.json({
      ok: true,
      message: `Resi berhasil divalidasi via ${validCourier.toUpperCase()}`,
      data: {
        resi: cleanResi,
        courierType: validCourier,
        validated: true,
        tracking: {
          summary: binderbyteResult.summary,
          detail: binderbyteResult.detail,
          history: binderbyteResult.history
        },
        createdAt: tracking.createdAt
      }
    });

  } catch (err) {
    console.error("POST /api/customer/manual-resi error:", err);
    return res.status(500).json({
      error: "Gagal menyimpan resi",
      message: "Terjadi kesalahan internal server"
    });
  }
});
// Agent melihat semua resi manual dari user
app.get("/api/manual-resi", async (req, res) => {
  try {
    const list = await CustomerTracking.find({})
      .sort({ createdAt: -1 })
      . lean();
    res.json({ data: list });
  } catch (err) {
    console.error("GET /api/manual-resi error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// List semua shipment milik customer (pakai JWT)
app.get("/api/customer/shipments", auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const shipments = await Shipment.find({ customerId: userId })
      . sort({ createdAt: -1 })
      .lean();

    res.json({ data: shipments });
  } catch (err) {
    console.error("GET /api/customer/shipments error:", err);
    res. status(500).json({ error: "Gagal mengambil data shipments" });
  }
});

// Customer minta buka locker untuk resi tertentu
app.post("/api/customer/open-locker", auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { resi, courierType } = req.body;

    if (!resi || ! courierType) {
      return res
        .status(400)
        .json({ error: "resi dan courierType wajib diisi" });
    }

    const shipment = await Shipment.findOne({
      resi,
      courierType,
      customerId: userId,
    });

    if (!shipment) {
      return res
        .status(404)
        .json({ error: "Shipment tidak ditemukan untuk user ini" });
    }

    const locker = await Locker.findOneAndUpdate(
      { lockerId: shipment.lockerId },
      {
        command: {
          type: "open",
          resi,
          source: "customer",
          createdAt: new Date(),
        },
      },
      { new: true }
    );

    if (!locker) {
      return res
        .status(404)
        .json({ error: "Locker tidak ditemukan untuk shipment ini" });
    }

    await LockerLog.create({
      lockerId: locker.lockerId,
      resi,
      action: "customer_open_request",
      at: new Date(),
    });

    res.json({
      message: "Permintaan buka loker dikirim ke ESP32",
      lockerId: locker.lockerId,
    });
  } catch (err) {
    console.error("POST /api/customer/open-locker error:", err);
    res.status(500).json({
      error: "Gagal mengirim permintaan buka loker",
      detail: err.message,
    });
  }
});

// Detail tracking 1 resi (Binderbyte + internal) - FIXED with auto-detect
app.get("/api/customer/track/:resi", async (req, res) => {
  const { resi } = req.params;
  const { courier } = req.query; // Optional now

  try {
    console.log(`[TRACKING REQUEST] Resi: ${resi}, Courier: ${courier || 'auto-detect'}`);

    // Find shipment in database
    const shipment = await Shipment.findOne({ resi }).lean();

    // Find in customer_trackings
    const tracking = await CustomerTracking.findOne({ resi }).lean();

    console.log(`[TRACKING] Shipment found: ${!!shipment}, Tracking found: ${!!tracking}`);

    // Auto-detect courier type from multiple sources
    let courierType = courier ||
                      shipment?.courierType ||
                      tracking?.courierType;

    console.log(`[TRACKING] Detected courier type: ${courierType}`);

    // If still no courier type, try to detect from resi or default to anteraja
    if (!courierType || courierType === 'unknown') {
      // Try common courier detection based on resi pattern
      if (resi.length === 14 && resi.startsWith('1')) {
        courierType = 'anteraja';
        console.log(`[TRACKING] Auto-detected anteraja from resi pattern`);
      } else {
        // Default to anteraja and let Binderbyte figure it out
        courierType = 'anteraja';
        console.log(`[TRACKING] Defaulting to anteraja`);
      }
    }

    // Prepare internal data
    const internalData = {
      shipment: shipment || null,
      tracking: tracking || null,
      found: !!(shipment || tracking),
    };

    // FAST RESPONSE: Return internal data immediately if no Binderbyte or if it might be slow
    const shouldFetchBinderbyte = BINDER_KEY && req.query.external !== 'false';

    if (!shouldFetchBinderbyte) {
      console.log(`[TRACKING] Returning internal data only (Binderbyte skipped)`);
      return res.json({
        ok: true,
        resi,
        courierType,
        internal: internalData,
        binderbyte: null,
        hasBinderbyte: false,
        message: "Data internal (Binderbyte dinonaktifkan untuk kecepatan)",
      });
    }

    // Try Binderbyte with shorter timeout for mobile
    let binderbyte = null;
    let usingCachedData = false;

    try {
      console.log(`[TRACKING] Fetching ${resi} from Binderbyte (${courierType})...`);

      const bbResp = await axios.get("https://api.binderbyte.com/v1/track", {
        params: {
          api_key: BINDER_KEY,
          courier: courierType,
          awb: resi,
        },
        timeout: 15000, // Reduced to 15 seconds for faster mobile response
      });

      if (bbResp.data && bbResp.data.status === 200) {
        binderbyte = bbResp.data.data;
        console.log(`[TRACKING] ✅ Live data from Binderbyte for ${resi}`);
      } else {
        console.log(`[TRACKING] ⚠️ No data from Binderbyte for ${resi}`);
      }
    } catch (bbErr) {
      console.error(`[TRACKING] Binderbyte error for ${resi}:`, bbErr.message);
      console.error(`[TRACKING] Error code:`, bbErr.code);
      console.error(`[TRACKING] Error details:`, bbErr.response?.status || 'No response');

      // 🔥 FALLBACK: Use cached Binderbyte data from customer_trackings if available
      if (tracking?.binderbyteData?.summary) {
        binderbyte = {
          summary: tracking.binderbyteData.summary,
          detail: [],
          history: [],
          cached: true,
          cachedAt: tracking.binderbyteData.validatedAt
        };
        usingCachedData = true;
        console.log(`[TRACKING] ✅ Using cached Binderbyte data from ${tracking.binderbyteData.validatedAt}`);
      } else {
        // Still return success with internal data even if Binderbyte fails
        binderbyte = {
          error: true,
          message: "Layanan tracking eksternal sedang sibuk. Data internal tetap tersedia.",
          code: bbErr.code || 'TIMEOUT',
          details: bbErr.message
        };
      }
    }

    // Return combined data - ALWAYS return success with internal data
    res.json({
      ok: true,
      resi,
      courierType,
      internal: internalData,
      binderbyte: binderbyte,
      hasBinderbyte: (binderbyte && !binderbyte.error) || usingCachedData,
      usingCachedData: usingCachedData,
      message: binderbyte?.error 
        ? "Data tracking internal tersedia (eksternal timeout)" 
        : usingCachedData 
        ? "Menggunakan data tracking yang tersimpan (cache)"
        : undefined,
    });

  } catch (err) {
    console.error("GET /api/customer/track/:resi error:", err);
    res.status(500).json({
      ok: false,
      error: "Gagal mengambil data tracking",
      detail: err.message,
      resi: resi,
    });
  }
});

// ---------------------- COURIER ENDPOINTS ----------------------

// GET semua kurir
app.get("/api/couriers", async (req, res) => {
  try {
    const couriers = await Courier.find({})
      .sort({ company: 1, name: 1 })
      .select('courierId name company plate phone status createdAt updatedAt')
      .lean();
    res.json({ ok: true, data: couriers });
  } catch (err) {
    console.error("GET /api/couriers error:", err);
    res.status(500). json({ error: "Internal server error" });
  }
});

// Tambah kurir baru
app. post("/api/couriers", async (req, res) => {
  try {
    let { name, company, plate } = req.body;

    if (!name || !company || !plate) {
      return res
        .status(400)
        . json({ error: "name, company, dan plate wajib diisi" });
    }

    name = name.trim();
    company = company.trim(). toLowerCase();
    plate = plate.trim().toUpperCase();

    const exists = await Courier.findOne({ plate, company });
    if (exists) {
      return res. status(400).json({
        error: "Kurir dengan plat & perusahaan ini sudah terdaftar",
      });
    }

    const courier = await Courier.create({
      courierId: "CR-" + company.toUpperCase(). slice(0, 3) + "-" + Date.now(),
      name,
      company,
      plate,
      state: "active",
    });

    res.json({ ok: true, message: "Kurir berhasil ditambahkan", data: courier });
  } catch (err) {
    console.error("POST /api/couriers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update status kurir (active / inactive)
app.put("/api/couriers/:courierId/status", async (req, res) => {
  try {
    const { courierId } = req.params;
    const { status } = req.body;

    // Only allow "active" or "inactive"
    if (!status || !["active", "inactive"].includes(status)) {
      return res.status(400).json({ 
        error: "Invalid status. Must be 'active' or 'inactive'" 
      });
    }

    const courier = await Courier.findOneAndUpdate(
      { courierId },
      { status },
      { new: true }
    );

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    console.log(`[AGENT] Courier ${courierId} status changed to: ${status}`);

    res.json({
      ok: true,
      message: `Status kurir diubah menjadi ${status}`,
      data: courier,
    });
  } catch (err) {
    console.error("PUT /api/couriers/:courierId/status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// SANITASI: hapus kurir
app.delete("/api/couriers/:courierId", async (req, res) => {
  try {
    await Courier.deleteOne({ courierId: req.params.courierId });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/couriers/:courierId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== COURIER REGISTRATION & AUTH ====================

// Courier Registration - Simple with name only
app.post("/api/courier/register", async (req, res) => {
  try {
    const { name, company, plate, phone, password } = req.body;

    // Validation
    if (!name || !company || !plate || !password) {
      return res.status(400).json({
        error: "Nama, perusahaan, plat kendaraan, dan password wajib diisi",
      });
    }

    // Normalize data
    const normalizedPlate = plate.trim().toUpperCase();
    const normalizedCompany = company.trim().toLowerCase();

    // Check if plate already exists for this company
    const existingPlate = await Courier.findOne({
      plate: normalizedPlate,
      company: normalizedCompany,
    });

    if (existingPlate) {
      return res.status(400).json({
        error: "Plat kendaraan ini sudah terdaftar untuk perusahaan yang sama",
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate courier ID
    const courierId = `CR-${normalizedCompany.toUpperCase().slice(0, 3)}-${Date.now()}`;

    // Create courier
    const courier = await Courier.create({
      courierId,
      name: name.trim(),
      company: normalizedCompany,
      plate: normalizedPlate,
      phone: phone?.trim() || "",
      passwordHash,
      status: "active",
    });

    console.log(`[COURIER REGISTER] ${courierId} (${name}) - ACTIVE`);

    return res.json({
      message: "Registrasi berhasil! Akun langsung aktif.",
      data: {
        courierId: courier.courierId,
        name: courier.name,
        company: courier.company,
        plate: courier.plate,
        status: courier.status,
      },
    });
  } catch (err) {
    console.error("POST /api/courier/register error:", err);
    return res.status(500).json({ error: "Gagal melakukan registrasi" });
  }
});

// Courier Login - Use NAME + password
app.post("/api/courier/login", async (req, res) => {
  try {
    const { name, password } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: "Nama dan password wajib diisi" });
    }

    const normalizedName = name.trim().toLowerCase();

    // Find courier by name (case-insensitive)
    const courier = await Courier.findOne({
      name: { $regex: new RegExp(`^${normalizedName}$`, 'i') }
    });

    if (!courier) {
      return res.status(401).json({
        error: "Nama tidak ditemukan. Silakan registrasi terlebih dahulu."
      });
    }

    // Check password
    if (!courier.passwordHash) {
      return res.status(401).json({
        error: "Akun ini belum memiliki password. Hubungi admin.",
      });
    }

    const passwordValid = await bcrypt.compare(password, courier.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Password salah" });
    }

    // Check courier status
    if (courier.status === "inactive") {
      return res.status(403).json({
        error: "Akun tidak aktif. Silakan hubungi admin.",
      });
    }

    // Don't auto-change status on login
    // Status only changed by agent manually

    // Generate JWT token
    const token = jwt.sign(
      {
        courierId: courier.courierId,
        name: courier.name,
        plate: courier.plate,
        company: courier.company,
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    console.log(`[COURIER LOGIN] ${courier.courierId} (${courier.name}) logged in`);

    return res.json({
      message: "Login berhasil",
      token,
      data: {
        courierId: courier.courierId,
        name: courier.name,
        company: courier.company,
        plate: courier.plate,
        status: courier.status,
      },
    });
  } catch (err) {
    console.error("POST /api/courier/login error:", err);
    return res.status(500).json({ error: "Gagal login" });
  }
});

// Courier Profile (protected route)
app.get("/api/courier/profile", authCourier, async (req, res) => {
  try {
    const courier = await Courier.findOne({
      courierId: req.courier.courierId,
    }).lean();

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    // Get courier stats
    const totalDeliveries = await Shipment.countDocuments({
      courierId: courier.courierId,
      status: "delivered_to_locker",
    });

    const pendingDeliveries = await Shipment.countDocuments({
      courierId: courier.courierId,
      status: "pending_locker",
    });

    return res.json({
      data: {
        courierId: courier.courierId,
        name: courier.name,
        company: courier.company,
        plate: courier.plate,
        phone: courier.phone,
        status: courier.status,
        stats: {
          totalDeliveries,
          pendingDeliveries,
        },
      },
    });
  } catch (err) {
    console.error("GET /api/courier/profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Update Courier Profile
app.put("/api/courier/profile", authCourier, async (req, res) => {
  try {
    const { name, phone } = req.body;

    const courier = await Courier.findOne({
      courierId: req.courier.courierId,
    });

    if (!courier) {
      return res.status(404).json({ error: "Courier not found" });
    }

    if (name) courier.name = name.trim();
    if (phone) courier.phone = phone.trim();

    await courier.save();

    return res.json({
      message: "Profile berhasil diupdate",
      data: {
        courierId: courier.courierId,
        name: courier.name,
        phone: courier.phone,
      },
    });
  } catch (err) {
    console.error("PUT /api/courier/profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Change Courier Password
app.post("/api/courier/change-password", authCourier, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({
        error: "Password lama dan password baru wajib diisi",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "Password baru minimal 6 karakter",
      });
    }

    const courier = await Courier.findOne({
      courierId: req.courier.courierId,
    });

    if (!courier || !courier.passwordHash) {
      return res.status(404).json({ error: "Courier not found" });
    }

    // Verify old password
    const passwordValid = await bcrypt.compare(oldPassword, courier.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Password lama salah" });
    }

    // Hash new password
    courier.passwordHash = await bcrypt.hash(newPassword, 10);
    await courier.save();

    console.log(`[COURIER] ${courier.courierId} changed password`);

    return res.json({
      message: "Password berhasil diubah",
    });
  } catch (err) {
    console.error("POST /api/courier/change-password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== OLD COURIER LOGIN (kept for backward compatibility) ====================

// Kurir login (OLD - name + plate method, kept for legacy apps)
app.post("/api/courier/login-legacy", async (req, res) => {
  try {
    const { name, plate } = req.body;
    if (!name || !plate) {
      return res. status(400).json({ error: "name dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    const courier = await Courier. findOne({
      plate: normalizedPlate,
    });
    if (!courier) {
      return res
        .status(401)
        .json({ error: "Kurir tidak terdaftar." });
    }

    if (courier.status === "inactive") {
      return res
        .status(401)
        .json({ error: "Kurir sudah tidak aktif.  Hubungi admin untuk aktivasi kembali." });
    }

    if (courier.name. toLowerCase() !== name.trim(). toLowerCase()) {
      return res. status(401).json({ error: "Nama kurir tidak sesuai" });
    }

    const exist = await Shipment.findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
    });
    if (! exist) {
      return res. status(401).json({
        error:
          "Tidak ada paket aktif untuk plat ini. Hubungi admin / agen jika merasa ini salah.",
      });
    }

    return res.json({
      message: "Login kurir berhasil",
      courierId: courier.courierId,
      name: courier.name,
      company: courier.company,
      plate: courier.plate,
    });
  } catch (err) {
    console.error("POST /api/courier/login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 🔹 Kurir deposit paket pakai lockerToken + resi (FIXED)
app.post("/api/courier/deposit-token", async (req, res) => {
  try {
    const { lockerId, lockerToken, resi } = req.body;

    console.log(`[COURIER SCAN] Attempt: lockerId=${lockerId}, resi=${resi}, token=${lockerToken?.substring(0, 15)}...`);

    if (!lockerId || ! lockerToken || !resi) {
      console.log(`[COURIER SCAN] Missing fields: lockerId=${!!lockerId}, token=${!!lockerToken}, resi=${!!resi}`);
      return res. status(400).json({
        error: "lockerId, lockerToken, dan resi wajib diisi",
      });
    }

    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404).json({ error: "Locker tidak ditemukan" });
    }

    // Validasi lockerToken (QR dari ESP32)
    if (! locker.lockerToken || locker.lockerToken !== lockerToken. trim()) {
      console.log(`[TOKEN VALIDATE] Failed: expected=${locker.lockerToken}, got=${lockerToken}`);
      return res
        .status(400)
        .json({ error: "Locker token tidak valid / kadaluarsa" });
    }

    // IMPROVED: Check shipment first to give better error messages
    let shipment = await Shipment.findOne({
      resi,
      lockerId,
    });

    // If not found by lockerId, try to find by resi only and check compatibility
    if (!shipment) {
      shipment = await Shipment.findOne({ resi });

      if (shipment) {
        // Shipment exists but for different locker
        console.log(`[DEPOSIT ERROR] Resi ${resi} assigned to locker ${shipment.lockerId}, not ${lockerId}`);
        return res.status(400).json({
          error: `Resi ini ditugaskan ke locker ${shipment.lockerId}, bukan ${lockerId}. Pastikan scan QR locker yang benar.`,
          expectedLockerId: shipment.lockerId,
          scannedLockerId: lockerId,
        });
      }

      // Shipment doesn't exist at all
      console.log(`[DEPOSIT ERROR] Resi ${resi} tidak ditemukan di sistem`);
      return res.status(404).json({
        error: "Tidak ada paket dengan resi ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
        lockerId,
        resi,
      });
    }

    // Check shipment status
    if (shipment.status !== "pending_locker") {
      console.log(`[DEPOSIT ERROR] Resi ${resi} status: ${shipment.status}`);
      return res.status(400).json({
        error: `Paket sudah ${shipment.status === "delivered_to_locker" ? "diantar" : "diproses"}. Status: ${shipment.status}`,
        currentStatus: shipment.status,
      });
    }

    // Auto-fix: Add to pendingResi if not already there
    if (! locker.pendingResi. includes(resi)) {
      console.log(`[AUTO-FIX] Adding ${resi} to pendingResi for ${lockerId}`);
      locker.pendingResi.push(resi);
    }

    console.log(`[DEPOSIT] Processing resi ${resi} for locker ${lockerId}`);

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { source: "courier_deposit_token" },
    });
    await shipment.save();

    // 🔹 STORE COURIER HISTORY BEFORE ROTATING TOKEN
    locker.courierHistory = locker.courierHistory || [];
    locker.courierHistory. push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "Unknown",
      courierPlate: shipment.courierPlate || "",
      resi,
      deliveredAt: new Date(),
      usedToken: lockerToken, // Store the old token that was used
    });

    // Command untuk ESP32
    locker.command = {
      type: "open",
      resi,
      source: "courier_token",
      createdAt: new Date(),
      customerId: shipment.customerId || "",
    };

    // Remove from pendingResi
    locker.pendingResi = locker.pendingResi.filter((r) => r !== resi);

    // 🔹 ROTATE TOKEN AFTER SUCCESSFUL DEPOSIT
    const oldToken = locker.lockerToken;
    locker.lockerToken = randomToken("LK-" + lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker.save();

    console.log(`[TOKEN ROTATE] ${lockerId}: ${oldToken} → ${locker.lockerToken}`);
    console.log(`[DEPOSIT SUCCESS] Resi ${resi} delivered to ${lockerId}`);

    // Recalc courier state
    if (shipment.courierId) {
      await recalcCourierState(shipment. courierId);
    }

    return res.json({
      ok: true,
      message: "Deposit berhasil, locker akan dibuka, token telah dirotasi",
      data: {
        lockerId,
        resi,
        customerId: shipment.customerId || "",
        oldToken, // For debugging
        newToken: locker.lockerToken,
      },
    });
  } catch (err) {
    console. error("POST /api/courier/deposit-token error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir deposit via scan QR token + plat (old method - kept for backward compatibility)
app.post("/api/courier/deposit", async (req, res) => {
  try {
    const { lockerToken, plate } = req.body;

    console.log(`[COURIER DEPOSIT-PLATE] Attempt: plate=${plate}, token=${lockerToken?.substring(0, 15)}...`);

    if (!lockerToken || !plate) {
      console.log(`[COURIER DEPOSIT-PLATE] Missing fields: token=${!!lockerToken}, plate=${!!plate}`);
      return res
        .status(400)
        .json({ error: "lockerToken dan plate wajib diisi" });
    }

    const normalizedPlate = plate.trim(). toUpperCase();

    const locker = await Locker.findOne({ lockerToken: lockerToken.trim() });
    if (!locker) {
      console.log(`[COURIER DEPOSIT-PLATE] Token not found: ${lockerToken}`);
      return res
        .status(404)
        .json({ error: "Locker dengan token ini tidak ditemukan" });
    }

    console.log(`[COURIER DEPOSIT-PLATE] Locker found: ${locker.lockerId}, searching for plate: ${normalizedPlate}`);

    const shipment = await Shipment. findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
      lockerId: locker.lockerId,
    });

    if (!shipment) {
      // Enhanced debugging: check what shipments exist
      const allShipmentsForLocker = await Shipment.find({
        lockerId: locker.lockerId,
        status: "pending_locker"
      }).lean();

      const allShipmentsForPlate = await Shipment.find({
        courierPlate: normalizedPlate,
        status: "pending_locker"
      }).lean();

      console.log(`[COURIER DEPOSIT-PLATE] ERROR - No match found`);
      console.log(`[COURIER DEPOSIT-PLATE] - Pending for locker "${locker.lockerId}": ${allShipmentsForLocker.length} shipments`);
      if (allShipmentsForLocker.length > 0) {
        console.log(`[COURIER DEPOSIT-PLATE]   Available plates: ${allShipmentsForLocker.map(s => s.courierPlate || 'NONE').join(', ')}`);
      }
      console.log(`[COURIER DEPOSIT-PLATE] - Pending for plate "${normalizedPlate}": ${allShipmentsForPlate.length} shipments`);
      if (allShipmentsForPlate.length > 0) {
        console.log(`[COURIER DEPOSIT-PLATE]   Assigned lockers: ${allShipmentsForPlate.map(s => s.lockerId).join(', ')}`);
      }

      return res.status(404).json({
        error:
          "Tidak ada paket pending untuk plat ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
        debug: {
          yourPlate: normalizedPlate,
          scannedLocker: locker.lockerId,
          pendingForThisLocker: allShipmentsForLocker.length,
          pendingForYourPlate: allShipmentsForPlate.length,
        }
      });
    }

    console.log(`[COURIER DEPOSIT-PLATE] Match found! Resi: ${shipment.resi}`);

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      timestamp: new Date(),
      extra: { source: "courier_deposit_plate" },
    });
    await shipment.save();

    // 🔹 STORE COURIER HISTORY BEFORE ROTATING TOKEN
    locker.courierHistory = locker.courierHistory || [];
    locker.courierHistory.push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "Unknown",
      courierPlate: normalizedPlate,
      resi: shipment.resi,
      deliveredAt: new Date(),
      usedToken: lockerToken,
    });

    locker.pendingResi = locker.pendingResi.filter((r) => r !== shipment.resi);
    locker.command = {
      type: "open",
      resi: shipment.resi,
      source: "courier",
      createdAt: new Date(),
    };

    // 🔹 ROTATE TOKEN AFTER SUCCESSFUL DEPOSIT
    const oldToken = locker.lockerToken;
    locker.lockerToken = randomToken("LK-" + locker.lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker.save();

    console.log(`[TOKEN ROTATE] ${locker.lockerId}: ${oldToken} → ${locker.lockerToken}`);

    // Log courier status (status no longer auto-updates)
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    return res.json({
      message: "Locker akan dibuka untuk paket ini, token telah dirotasi",
      lockerId: locker.lockerId,
      resi: shipment.resi,
      courierPlate: normalizedPlate,
      oldToken,
      newToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("POST /api/courier/deposit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir: ambil daftar shipment (simplified - no per-resi token)
app.get("/api/courier/tasks", async (req, res) => {
  try {
    const { plate, courierId } = req.query;

    const filter = {
      status: "pending_locker", // shipment yang belum masuk locker
    };

    if (plate) {
      filter.courierPlate = plate.trim().toUpperCase();
    }
    if (courierId) {
      filter.courierId = courierId;
    }

    const shipments = await Shipment.find(filter). lean();

    return res.json({
      ok: true,
      data: shipments. map((s) => ({
        shipmentId: s._id,
        resi: s.resi,
        lockerId: s.lockerId,
        courierType: s.courierType,
        courierPlate: s. courierPlate,
        customerId: s.customerId,
        status: s.status,
      })),
    });
  } catch (err) {
    console.error("GET /api/courier/tasks error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir deposit paket - SIMPLIFIED: only needs lockerToken + resi
// Implements ONE-TIME TOKEN with courier history tracking
app.post("/api/courier/deposit-resi", async (req, res) => {
  try {
    const { lockerId, lockerToken, resi, debug, scanAtClient } = req.body;

    console.log(`[COURIER DEPOSIT-RESI] Attempt: lockerId=${lockerId}, resi=${resi}, token=${lockerToken?.substring(0, 15)}..., debug=${debug}`);

    if (!lockerId || !lockerToken || ! resi) {
      console.log(`[COURIER DEPOSIT-RESI] Missing fields: lockerId=${!!lockerId}, token=${!!lockerToken}, resi=${!!resi}`);
      return res.status(400).json({
        error: "lockerId, lockerToken, dan resi wajib diisi",
      });
    }

    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404).json({ error: "Locker tidak ditemukan" });
    }

    // 🔍 DEBUG: tandai waktu scan di backend (dan optional dari client)
    if (debug) {
      const clientTime = scanAtClient ? new Date(scanAtClient) : null;
      locker.debugInfo = locker.debugInfo || {};
      locker.debugInfo.enabled = true;
      locker.debugInfo.resi = resi;
      locker.debugInfo.scanAtBackend = new Date();
      if (clientTime) locker.debugInfo.scanAtClient = clientTime;

      console.log(
        `[DEBUG-QR] START locker=${lockerId} resi=${resi} scanAtBackend=${locker.debugInfo.scanAtBackend.toISOString()}` +
          (clientTime ? ` scanAtClient=${clientTime.toISOString()}` : "")
      );
    }

    // Validasi lockerToken (QR dari ESP32)
    if (!locker.lockerToken || locker.lockerToken !== lockerToken.trim()) {
      console.log(`[TOKEN VALIDATE] ${lockerId}: Token validation failed`);
      return res
        .status(400)
        .json({ error: "Invalid or expired token" });
    }

    // IMPROVED: Check shipment first to give better error messages
    let shipment = await Shipment.findOne({
      resi,
      lockerId,
    });

    // If not found by lockerId, try to find by resi only and check compatibility
    if (!shipment) {
      shipment = await Shipment.findOne({ resi });

      if (shipment) {
        // Shipment exists but for different locker
        console.log(`[DEPOSIT ERROR] Resi ${resi} assigned to locker ${shipment.lockerId}, not ${lockerId}`);
        return res.status(400).json({
          error: `Resi ini ditugaskan ke locker ${shipment.lockerId}, bukan ${lockerId}. Pastikan scan QR locker yang benar.`,
          expectedLockerId: shipment.lockerId,
          scannedLockerId: lockerId,
        });
      }

      // Shipment doesn't exist at all
      console.log(`[DEPOSIT ERROR] Resi ${resi} tidak ditemukan di sistem`);
      return res.status(404).json({
        error: "Tidak ada paket dengan resi ini di locker tersebut. Pastikan locker & resi sudah diassign oleh agen.",
        lockerId,
        resi,
      });
    }

    // Check shipment status
    if (shipment.status !== "pending_locker") {
      console.log(`[DEPOSIT ERROR] Resi ${resi} status: ${shipment.status}`);
      return res.status(400).json({
        error: `Paket sudah ${shipment.status === "delivered_to_locker" ? "diantar" : "diproses"}. Status: ${shipment.status}`,
        currentStatus: shipment.status,
      });
    }

    // Auto-fix: Add to pendingResi if not already there
    if (! locker.pendingResi. includes(resi)) {
      console.log(`[AUTO-FIX] Adding ${resi} to pendingResi for ${lockerId}`);
      locker.pendingResi.push(resi);
    }

    console.log(`[DEPOSIT] Processing resi ${resi} for locker ${lockerId}`);

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { source: "courier_deposit_resi" },
    });
    await shipment.save();

    // command untuk ESP32
    locker. command = {
      type: "open",
      resi,
      source: "courier_resi",
      createdAt: new Date(),
      customerId: shipment.customerId || "",
    };

    // Remove from pendingResi
    locker. pendingResi = locker. pendingResi.filter((r) => r !== resi);

    // ========== ONE-TIME TOKEN: Record courier history and rotate token ==========
    const oldToken = locker.lockerToken;

    // Add courier delivery to history
    locker.courierHistory. push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "",
      courierPlate: shipment.courierPlate || "",
      resi,
      deliveredAt: new Date(),
      usedToken: oldToken, // Store the token that was used
    });

    // Rotate token - generate new unique token
    locker.lockerToken = randomToken("LK-" + lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker. save();

    console.log(`[TOKEN ROTATE] ${lockerId}: Token rotated successfully`);

    // Recalc courier state
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    return res.json({
      ok: true,
      message: "Deposit berhasil, locker akan dibuka",
      data: {
        lockerId,
        resi,
        customerId: shipment.customerId || "",
      },
    });
  } catch (err) {
    console. error("POST /api/courier/deposit-resi error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Mark shipment as delivered to customer (called when package is picked up)
app.post("/api/shipments/:resi/delivered-customer", async (req, res) => {
  try {
    const { resi } = req.params;

    const shipment = await Shipment.findOneAndUpdate(
      { resi },
      {
        status: "delivered_to_customer",
        deliveredToCustomerAt: new Date(),
      },
      { new: true }
    );

    if (! shipment) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    // hapus resi dari pendingResi locker
    await Locker.updateOne(
      { lockerId: shipment.lockerId },
      { $pull: { pendingResi: resi } }
    );

    // Recalculate state kurir yang mengantar shipment ini
    if (shipment.courierId) {
      await recalcCourierState(shipment.courierId);
    }

    res.json({ ok: true, data: shipment });
  } catch (err) {
    console.error("POST /api/shipments/:resi/delivered-customer error:", err);
    res.status(500).json({ error: "Failed to mark delivered" });
  }
});

// Kurir scan locker (QR code scan validation)
app.post("/api/scan", async (req, res) => {
  try {
    const { courierId, lockerId, token, resi } = req.body;

    if (!courierId || ! lockerId || !token) {
      return res.status(400).json({ error: "courierId, lockerId, dan token wajib diisi" });
    }

    const courier = await Courier.findOne({ courierId });
    if (! courier) {
      return res. status(404).json({ error: "Courier not found" });
    }

    if (courier.status === "inactive") {
      return res.status(403).json({ error: "Courier is inactive, cannot scan" });
    }

    // Validate locker token
    const locker = await Locker.findOne({ lockerId, lockerToken: token });
    if (!locker) {
      return res.status(404).json({ error: "Invalid locker or token" });
    }

    // If resi provided, validate it belongs to this courier and locker
    if (resi) {
      const shipment = await Shipment.findOne({
        resi,
        courierId,
        lockerId,
        status: "pending_locker",
      });

      if (!shipment) {
        return res.status(404).json({
          error: "Resi tidak ditemukan atau tidak sesuai dengan kurir dan locker ini",
        });
      }
    }

    res.json({
      ok: true,
      message: "Scan berhasil",
      lockerId,
      courierId,
    });
  } catch (err) {
    console.error("POST /api/scan error:", err);
    res.status(500). json({ error: "Scan failed" });
  }
});

// ---------------------- LOCKER LIST / POOL ----------------------

// GET semua locker (untuk Agent Locker Client Pool)
app.get("/api/lockers", async (req, res) => {
  try {
    const lockers = await Locker.find();
    console.log(`[DEBUG] GET /api/lockers - Found ${lockers.length} lockers`);

    // Status calculation logic
    const now = new Date();
    const updatedLockers = lockers.map(locker => {
      let status = "unknown";
      if (locker.lastHeartbeat) {
        const diff = now - new Date(locker.lastHeartbeat);
        // 2 minutes threshold for online
        if (diff < 2 * 60 * 1000) {
          status = "online";
        } else {
          status = "offline";
        }
      }
      return {
        ... locker. toObject(),
        status,
      };
    });

    return res.json(updatedLockers);
  } catch (err) {
    console.error("GET /api/lockers error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET detail locker
app.get("/api/lockers/:lockerId", async (req, res) => {
  try {
    const locker = await Locker.findOne({
      lockerId: req.params.lockerId,
    }).lean();

    if (!locker) return res.status(404).json({ error: "Locker not found" });

    res.json({ data: locker });
  } catch (err) {
    console. error("GET /api/lockers/:lockerId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// NEW: Get courier history for a locker
app.get("/api/lockers/:lockerId/courier-history", async (req, res) => {
  try {
    const { lockerId } = req.params;

    const locker = await Locker.findOne({ lockerId }).lean();

    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }

    res.json({
      lockerId: locker. lockerId,
      currentToken: locker.lockerToken,
      tokenUpdatedAt: locker.tokenUpdatedAt,
      courierHistory: locker.courierHistory || [],
    });
  } catch (err) {
    console.error("GET /api/lockers/:lockerId/courier-history error:", err);
    res. status(500).json({ error: "Internal server error" });
  }
});

// SANITASI: hapus locker
app.delete("/api/lockers/:lockerId", async (req, res) => {
  try {
    await Locker.deleteOne({ lockerId: req.params.lockerId });
    res.json({ ok: true });
  } catch (err) {
    console. error("DELETE /api/lockers/:lockerId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------- ESP32 & Locker Command ----------------------

// Ambil token locker (QR) untuk ESP32 + HEARTBEAT
app.get("/api/locker/:lockerId/token", async (req, res) => {
  const { lockerId } = req.params;

  try {
    let locker = await Locker. findOne({ lockerId });

    if (!locker) {
      locker = await Locker.create({
        lockerId,
        lockerToken: randomToken("LK-" + lockerId),
        isActive: true,
        status: "offline",
        courierHistory: [],
      });
    }

    const now = new Date();

    // update heartbeat + status
    locker.lastHeartbeat = now;
    locker.status = "online";
    await locker.save();

    console.log(`[HEARTBEAT] Locker ${lockerId} token: ${locker.lockerToken}`);

    res.json({
      lockerId: locker.lockerId,
      lockerToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("get locker token error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Kurir titip paket ke locker (mode lama: token + resi manual)
app.post("/api/locker/:lockerId/deposit", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { token, resi } = req.body;

    if (!token || ! resi) {
      return res.status(400).json({ error: "token dan resi wajib diisi" });
    }

    const locker = await getLocker(lockerId);

    if (token !== locker.lockerToken) {
      return res.status(403).json({ error: "Token locker tidak valid" });
    }

    if (! locker.pendingResi.includes(resi)) {
      return res.status(403).json({
        error: "Resi tidak terdaftar untuk locker ini atau sudah diproses",
        pendingResi: locker.pendingResi,
      });
    }

    const shipment = await Shipment.findOne({ resi });
    if (!shipment) {
      return res.status(404).json({ error: "Shipment/resi tidak ditemukan" });
    }

    shipment.status = "delivered_to_locker";
    shipment.deliveredToLockerAt = new Date();
    shipment.logs.push({
      event: "delivered_to_locker",
      lockerId,
      resi,
      timestamp: new Date(),
      extra: { source: "locker_deposit_legacy" },
    });
    await shipment.save();

    // 🔹 STORE COURIER HISTORY
    locker.courierHistory = locker.courierHistory || [];
    locker.courierHistory.push({
      courierId: shipment.courierId || "",
      courierName: shipment.courierName || "Unknown",
      courierPlate: shipment.courierPlate || "",
      resi,
      deliveredAt: new Date(),
      usedToken: token,
    });

    locker.pendingResi = locker.pendingResi.filter((r) => r !== resi);
    locker.command = {
      type: "open",
      resi,
      source: "courier",
      createdAt: new Date(),
    };

    // 🔹 ROTATE TOKEN
    const oldToken = locker.lockerToken;
    locker.lockerToken = randomToken("LK-" + lockerId);
    locker.tokenUpdatedAt = new Date();

    await locker.save();

    console.log(`[TOKEN ROTATE] ${lockerId}: ${oldToken} → ${locker.lockerToken}`);

    return res.json({
      message: "Locker akan dibuka untuk resi ini, token telah dirotasi",
      lockerId,
      resi,
      remainingPendingResi: locker.pendingResi,
      oldToken,
      newToken: locker.lockerToken,
    });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/deposit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 polling command (open, dsb.)
app.get("/api/locker/:lockerId/command", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await getLocker(lockerId);

    if (!locker. command) {
      return res. json({ command: "none" });
    }

    const cmd = locker.command;

    // 🔍 DEBUG: catat kapan ESP32 menarik command (polling)
    if (locker.debugInfo?.enabled) {
      pushDebugPhase(locker, "command", { resi: cmd.resi });

      // Hitung durasi dari scan (backend) ke command diambil ESP
      if (locker.debugInfo.scanAtBackend) {
        const diffMs =
          new Date() - new Date(locker.debugInfo.scanAtBackend);
        console.log(
          `[DEBUG-QR] Δ scan(backend) → command(ESP poll) = ${diffMs} ms (locker=${lockerId}, resi=${cmd.resi})`
        );
      }
    }

    locker.command = null; // one-shot
    await locker.save();

    console.log(`[COMMAND] Sent to ${lockerId}: ${cmd.type}`);

    return res.json({
      command: cmd.type,
      resi: cmd.resi,
      source: cmd.source,
      createdAt: cmd.createdAt,
    });
  } catch (err) {
    console. error("GET /api/locker/:lockerId/command error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 heartbeat - dipanggil berkala oleh ESP32
app.post("/api/locker/:lockerId/heartbeat", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const locker = await Locker.findOne({ lockerId });
    if (!locker) {
      return res.status(404). json({ error: "Locker not found" });
    }
    locker.status = "online";
    locker.lastHeartbeat = new Date();
    await locker. save();
    console.log(`[HEARTBEAT] Locker ${lockerId} at ${locker.lastHeartbeat}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/heartbeat error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ESP32 kirim log event
app.post("/api/locker/:lockerId/log", async (req, res) => {
  try {
    const { lockerId } = req.params;
    const { event, resi, extra } = req.body;

    const shipment = resi ? await Shipment.findOne({ resi }) : null;
    const logEntry = {
      event,
      lockerId,
      resi: resi || null,
      extra: extra || null,
      timestamp: new Date(),
    };

    // 🔍 DEBUG: kalau event dari ESP adalah buka loker, hitung total waktu
    if (["locker_opened", "opened_by_courier"].includes(event)) {
      const locker = await Locker.findOne({ lockerId });

      if (locker?.debugInfo?.enabled && locker.debugInfo.scanAtBackend) {
        pushDebugPhase(locker, "esp_log", { resi });

        const tScanBackend = new Date(locker.debugInfo.scanAtBackend);
        const tEspLog = logEntry.timestamp;

        const totalMs = tEspLog - tScanBackend;
        let clientPart = null;

        if (locker.debugInfo.scanAtClient) {
          clientPart = tScanBackend - new Date(locker.debugInfo.scanAtClient);
        }

        console.log(
          `[DEBUG-QR] FINAL locker=${lockerId} resi=${resi} ` +
            `(scanBackend→espLog = ${totalMs} ms` +
            (clientPart != null ? `, scanClient→backend = ${clientPart} ms` : "") +
            `)`
        );

        await locker.save();
      }
    }

    if (shipment) {
      shipment.logs.push(logEntry);

      if (
        event === "locker_closed" &&
        shipment.status === "delivered_to_locker"
      ) {
        shipment.status = "ready_for_pickup";
      }

      if (event === "opened_by_customer") {
        shipment.pickedUpAt = new Date();
        shipment.status = "completed";
      }

      await shipment.save();
    }

    console.log("Locker log:", logEntry);
    return res.json({ message: "Log received", log: logEntry });
  } catch (err) {
    console.error("POST /api/locker/:lockerId/log error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------- Binderbyte Proxy ----------------------

// Proxy tracking umum ke Binderbyte
app.get("/api/track", async (req, res) => {
  try {
    const { courier, awb } = req.query;
    if (!courier || !awb) {
      return res
        .status(400)
        .json({ error: "courier dan awb (nomor resi) wajib diisi" });
    }

    const url = "https://api.binderbyte.com/v1/track";
    const response = await axios.get(url, {
      params: {
        api_key: BINDER_KEY,
        courier,
        awb,
      },
    });

    return res.json(response.data);
  } catch (err) {
    console.error("Tracking error:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: "Gagal mengambil data tracking dari Binderbyte" });
  }
});

// ---------------------- DEBUG ----------------------

app.get("/api/debug/locker/:lockerId", async (req, res) => {
  try {
    const locker = await getLocker(req.params.lockerId);
    return res.json(locker);
  } catch (err) {
    console.error("GET /api/debug/locker error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/debug/shipment/:resi", async (req, res) => {
  try {
    const shipment = await Shipment.findOne({ resi: req.params.resi });
    if (!shipment) return res.status(404).json({ error: "Not found" });
    return res.json(shipment);
  } catch (err) {
    console.error("GET /api/debug/shipment error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Check resi + locker compatibility (troubleshooting endpoint)
app.get("/api/debug/check/:lockerId/:resi", async (req, res) => {
  try {
    const { lockerId, resi } = req.params;

    const locker = await Locker.findOne({ lockerId }).lean();
    const shipment = await Shipment.findOne({ resi }).lean();

    return res.json({
      lockerId,
      resi,
      locker: locker ? {
        lockerId: locker.lockerId,
        lockerToken: locker.lockerToken,
        pendingResi: locker.pendingResi,
        isResiInPending: locker.pendingResi?.includes(resi) || false,
      } : null,
      shipment: shipment ? {
        resi: shipment.resi,
        lockerId: shipment.lockerId,
        status: shipment.status,
        courierId: shipment.courierId,
        courierPlate: shipment.courierPlate,
        courierName: shipment.courierName,
      } : null,
      analysis: {
        lockerExists: !!locker,
        shipmentExists: !!shipment,
        lockerMatches: shipment?.lockerId === lockerId,
        resiInPending: locker?.pendingResi?.includes(resi) || false,
        canDeposit: !!shipment && !!locker && shipment.lockerId === lockerId && shipment.status === "pending_locker",
        statusReason: !shipment ? "Shipment not found" :
                      !locker ? "Locker not found" :
                      shipment.lockerId !== lockerId ? `Wrong locker (expected ${shipment.lockerId})` :
                      shipment.status !== "pending_locker" ? `Wrong status (${shipment.status})` : "OK",
      },
    });
  } catch (err) {
    console.error("GET /api/debug/check error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get all pending shipments for a locker
app.get("/api/debug/locker/:lockerId/pending", async (req, res) => {
  try {
    const { lockerId } = req.params;

    const locker = await Locker.findOne({ lockerId }).lean();
    if (!locker) {
      return res.status(404).json({ error: "Locker not found" });
    }

    const pendingShipments = await Shipment.find({
      lockerId,
      status: "pending_locker",
    }).lean();

    return res.json({
      lockerId,
      lockerToken: locker.lockerToken,
      pendingResiInLocker: locker.pendingResi || [],
      pendingShipments: pendingShipments.map(s => ({
        resi: s.resi,
        courierPlate: s.courierPlate,
        courierName: s.courierName,
        courierId: s.courierId,
        customerId: s.customerId,
        status: s.status,
        createdAt: s.createdAt,
      })),
      count: pendingShipments.length,
      mismatch: locker.pendingResi.filter(resi =>
        !pendingShipments.some(s => s.resi === resi)
      ),
    });
  } catch (err) {
    console.error("GET /api/debug/locker/:lockerId/pending error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== GET UNIQUE CUSTOMERS FROM customer_trackings ====================

// ✨ FIX TYPO: Update shipment locker name
app.post("/api/debug/fix-locker-name", async (req, res) => {
  try {
    const { resi, oldLockerId, newLockerId } = req.body;

    if (!resi || !oldLockerId || !newLockerId) {
      return res.status(400).json({
        error: "resi, oldLockerId, dan newLockerId wajib diisi"
      });
    }

    const shipment = await Shipment.findOne({ resi, lockerId: oldLockerId });

    if (!shipment) {
      return res.status(404).json({
        error: `Shipment dengan resi ${resi} di locker ${oldLockerId} tidak ditemukan`
      });
    }

    const oldLocker = await Locker.findOne({ lockerId: oldLockerId });
    const newLocker = await Locker.findOne({ lockerId: newLockerId });

    // Update shipment
    shipment.lockerId = newLockerId;
    await shipment.save();

    // Update old locker pendingResi
    if (oldLocker) {
      oldLocker.pendingResi = oldLocker.pendingResi.filter(r => r !== resi);
      await oldLocker.save();
    }

    // Update new locker pendingResi
    if (newLocker) {
      if (!newLocker.pendingResi.includes(resi)) {
        newLocker.pendingResi.push(resi);
        await newLocker.save();
      }
    }

    console.log(`[FIX] Moved shipment ${resi} from ${oldLockerId} to ${newLockerId}`);

    return res.json({
      ok: true,
      message: `Shipment ${resi} dipindahkan dari ${oldLockerId} ke ${newLockerId}`,
      shipment: {
        resi: shipment.resi,
        oldLockerId,
        newLockerId,
        status: shipment.status,
      }
    });
  } catch (err) {
    console.error("POST /api/debug/fix-locker-name error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ✨ AUTO-FIX: Fix locker name by courier plate
app.post("/api/debug/fix-by-plate", async (req, res) => {
  try {
    const { plate, correctLockerId } = req.body;

    if (!plate || !correctLockerId) {
      return res.status(400).json({
        error: "plate dan correctLockerId wajib diisi"
      });
    }

    const normalizedPlate = plate.trim().toUpperCase();

    // Find pending shipment with this plate
    const shipment = await Shipment.findOne({
      courierPlate: normalizedPlate,
      status: "pending_locker",
    });

    if (!shipment) {
      return res.status(404).json({
        error: `Tidak ada shipment pending untuk plat ${normalizedPlate}`
      });
    }

    const oldLockerId = shipment.lockerId;

    if (oldLockerId === correctLockerId) {
      return res.json({
        ok: true,
        message: "Locker ID sudah benar, tidak perlu diperbaiki",
        shipment: {
          resi: shipment.resi,
          lockerId: shipment.lockerId,
        }
      });
    }

    // Update shipment
    shipment.lockerId = correctLockerId;
    await shipment.save();

    // Update old locker
    const oldLocker = await Locker.findOne({ lockerId: oldLockerId });
    if (oldLocker) {
      oldLocker.pendingResi = oldLocker.pendingResi.filter(r => r !== shipment.resi);
      await oldLocker.save();
    }

    // Update new locker
    const newLocker = await Locker.findOne({ lockerId: correctLockerId });
    if (newLocker) {
      if (!newLocker.pendingResi.includes(shipment.resi)) {
        newLocker.pendingResi.push(shipment.resi);
        await newLocker.save();
      }
    }

    console.log(`[AUTO-FIX] Moved shipment ${shipment.resi} from ${oldLockerId} to ${correctLockerId} (plate: ${normalizedPlate})`);

    return res.json({
      ok: true,
      message: `Shipment untuk plat ${normalizedPlate} dipindahkan dari ${oldLockerId} ke ${correctLockerId}`,
      fixed: {
        resi: shipment.resi,
        plate: normalizedPlate,
        oldLockerId,
        newLockerId: correctLockerId,
      }
    });
  } catch (err) {
    console.error("POST /api/debug/fix-by-plate error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Check all pending shipments in system
app.get("/api/debug/all-pending", async (req, res) => {
  try {
    const pendingShipments = await Shipment.find({
      status: "pending_locker"
    }).sort({ createdAt: -1 }).limit(50).lean();

    return res.json({
      ok: true,
      count: pendingShipments.length,
      shipments: pendingShipments.map(s => ({
        resi: s.resi,
        lockerId: s.lockerId,
        courierPlate: s.courierPlate || 'NOT SET',
        courierName: s.courierName || 'NOT SET',
        courierId: s.courierId || 'NOT SET',
        customerId: s.customerId,
        createdAt: s.createdAt,
      }))
    });
  } catch (err) {
    console.error("GET /api/debug/all-pending error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== GET UNIQUE CUSTOMERS FROM customer_trackings ====================

// Get list of unique customers from customer_trackings collection
app.get("/api/customers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "500", 10);

    // Get all customer trackings
    const trackings = await CustomerTracking.find({
      customerId: { $exists: true, $ne: null, $ne: "" },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Extract unique customers
    const customerMap = new Map();

    trackings.forEach(tracking => {
      const customerId = tracking.customerId?.trim();

      if (customerId) {
        if (!customerMap.has(customerId)) {
          customerMap.set(customerId, {
            customerId: customerId,
            name: 'Unknown', // Will be filled from User collection
            phone: '',
            lastUsed: tracking.createdAt,
            totalResi: 1,
            resiList: [tracking.resi],
          });
        } else {
          // Update existing customer
          const existing = customerMap.get(customerId);
          existing.totalResi += 1;
          existing.resiList.push(tracking.resi);

          if (new Date(tracking.createdAt) > new Date(existing.lastUsed)) {
            existing.lastUsed = tracking.createdAt;
          }
        }
      }
    });

    // Now fetch user details for each customer ID
    const customerIds = Array.from(customerMap.keys());
    const users = await User.find({
      userId: { $in: customerIds },
      role: "customer",
    })
      .select("userId name phone email")
      .lean();

    // Merge user data into customer map
    users.forEach(user => {
      if (customerMap.has(user.userId)) {
        const customer = customerMap.get(user.userId);
        customer.name = user.name || 'Unknown';
        customer.phone = user.phone || '';
        customer.email = user.email || '';
        customer.registered = true;
      }
    });

    // Convert to array and sort by most recent
    const customers = Array.from(customerMap.values())
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));

    console.log(`[API] Found ${customers.length} unique customers from customer_trackings`);
    console.log(`[API] ${users.length} customers are registered users`);

    res.json({
      ok: true,
      count: customers.length,
      data: customers,
      source: 'customer_trackings',
    });
  } catch (err) {
    console.error("GET /api/customers error:", err);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// ==================== SEARCH CUSTOMERS (optional - for better UX) ====================

// Search customers by ID, name, or phone
app.get("/api/customers/search", async (req, res) => {
  try {
    const { q } = req.query; // search query

    if (!q || q.length < 2) {
      return res.json({ ok: true, data: [] });
    }

    const searchRegex = new RegExp(q, "i"); // case-insensitive

    // Search in shipments
    const shipments = await Shipment.find({
      $or: [
        { customerId: searchRegex },
        { receiverName: searchRegex },
        { receiverPhone: searchRegex },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Extract unique matches
    const customerMap = new Map();

    shipments.forEach(shipment => {
      const customerId = shipment.customerId?.trim();

      if (customerId && !customerMap.has(customerId)) {
        customerMap.set(customerId, {
          customerId: customerId,
          name: shipment.receiverName || 'Unknown',
          phone: shipment.receiverPhone || '',
          lastUsed: shipment.createdAt,
          matchedField:
            shipment.customerId.match(searchRegex) ? 'id' :
            shipment.receiverName?.match(searchRegex) ? 'name' : 'phone',
        });
      }
    });

    const results = Array.from(customerMap.values())
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));

    console.log(`[SEARCH] Query: "${q}", found ${results.length} customers`);

    res.json({
      ok: true,
      query: q,
      count: results.length,
      data: results,
    });
  } catch (err) {
    console.error("GET /api/customers/search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ==================== GET REGISTERED CUSTOMERS (from User collection) ====================

// Get customers who registered via mobile app
app.get("/api/customers/registered", async (req, res) => {
  try {
    const users = await User.find({ role: "customer" })
      .select("userId name email phone createdAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Also get their shipment count
    const customersWithStats = await Promise.all(
      users.map(async (user) => {
        const shipmentCount = await Shipment.countDocuments({
          customerId: user.userId,
        });

        return {
          customerId: user.userId,
          name: user.name,
          phone: user.phone,
          email: user.email,
          registered: true,
          totalOrders: shipmentCount,
          lastUsed: user.createdAt,
        };
      })
    );

    res.json({
      ok: true,
      count: customersWithStats.length,
      data: customersWithStats,
    });
  } catch (err) {
    console.error("GET /api/customers/registered error:", err);
    res.status(500).json({ error: "Failed to fetch registered customers" });
  }
});

// ==================== CUSTOMER STATISTICS ====================

// Get detailed stats for a specific customer
app.get("/api/customers/:customerId/stats", async (req, res) => {
  try {
    const { customerId } = req.params;

    const shipments = await Shipment.find({ customerId })
      .sort({ createdAt: -1 })
      .lean();

    if (shipments.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const stats = {
      customerId,
      name: shipments[0].receiverName,
      phone: shipments[0].receiverPhone,
      totalOrders: shipments.length,
      pending: shipments.filter(s => s.status === 'pending_locker').length,
      delivered: shipments.filter(s => s.status === 'delivered_to_locker').length,
      completed: shipments.filter(s => s.status === 'completed').length,
      firstOrder: shipments[shipments.length - 1].createdAt,
      lastOrder: shipments[0].createdAt,
      recentShipments: shipments.slice(0, 5).map(s => ({
        resi: s.resi,
        status: s.status,
        lockerId: s.lockerId,
        createdAt: s.createdAt,
      })),
    };

    res.json({
      ok: true,
      data: stats,
    });
  } catch (err) {
    console.error("GET /api/customers/:customerId/stats error:", err);
    res.status(500).json({ error: "Failed to fetch customer stats" });
  }
});

// ==================================================
// DATABASE MIGRATION - Run once to migrate courier data
// ==================================================
async function migrateCouriers() {
  try {
    const couriers = await Courier.find({});
    let migrated = 0;
    
    for (const courier of couriers) {
      let needsSave = false;
      
      // Convert old "state" to new "status" if it exists
      if (courier.state !== undefined) {
        courier.status = (courier.state === "inactive") ? "inactive" : "active";
        courier.state = undefined;
        needsSave = true;
      }
      
      // Remove deprecated fields
      if (courier.lastActiveAt !== undefined) {
        courier.lastActiveAt = undefined;
        needsSave = true;
      }
      if (courier.inactiveSince !== undefined) {
        courier.inactiveSince = undefined;
        needsSave = true;
      }
      
      if (needsSave) {
        await courier.save();
        migrated++;
      }
    }
    
    if (migrated > 0) {
      console.log(`[MIGRATION] Updated ${migrated} courier(s) to new schema`);
    } else {
      console.log(`[MIGRATION] No couriers needed migration`);
    }
  } catch (err) {
    console.error("[MIGRATION] Error:", err);
  }
}

// Run migration once on startup (remove this code after first run if desired)
setTimeout(migrateCouriers, 5000);

// ==================================================
// START SERVER
// ==================================================
app.listen(PORT, () => {
  console.log(`Smart Locker backend running at http://localhost:${PORT}`);
});
