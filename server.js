import express from "express";
import multer from "multer";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { createStorage } from "./storage.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_PDF = 5 * 1024 * 1024;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const APP_ID = /^\d{4}-\d{2}-\d{2}_[a-f0-9-]{36}$/;
const TYPES = ["Full-time", "Part-time", "Contract", "Internship"];
const hash = (value) => createHash("sha256").update(value).digest();
const same = (a, b) => timingSafeEqual(hash(a), hash(b));
const fail = (status, message, fields) =>
  Object.assign(new Error(message), { status, fields });
const text = (value, max) =>
  typeof value === "string" && value.trim().length <= max ? value.trim() : "";

export function createApp({
  env = process.env,
  storage = createStorage(env),
  now = Date.now,
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", Number(env.TRUST_PROXY || 0));
  app.use(cookieParser());
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    });
    if (req.path.startsWith("/api") || req.path.startsWith("/admin"))
      res.set({
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "no-store",
      });
    if (req.path.startsWith("/api") && !["GET", "HEAD"].includes(req.method)) {
      const expected = env.SITE_URL || `${req.protocol}://${req.get("host")}`;
      if (
        (req.get("origin") && req.get("origin") !== new URL(expected).origin) ||
        req.get("sec-fetch-site") === "cross-site"
      )
        return res
          .status(403)
          .json({ error: "Please submit from this website." });
    }
    next();
  });
  const enabled = () =>
    typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= 10;
  const signature = (payload) =>
    createHmac("sha256", env.ADMIN_PASSWORD)
      .update(payload)
      .digest("base64url");
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: "/api/admin",
  };
  function authenticate(req, res, next) {
    if (!enabled())
      return res.status(503).json({ error: "Admin access is not configured." });
    const token = req.cookies.admin_session || "";
    const [payload, sig] = token.split(".");
    try {
      if (!payload || !sig || !same(signature(payload), sig)) throw new Error();
      const session = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (session.exp <= now() || session.exp > now() + 12 * 3600000)
        throw new Error();
      next();
    } catch {
      res
        .status(401)
        .json({ error: "Your session has expired. Please sign in again." });
    }
  }
  const needStorage = (req, res, next) =>
    storage
      ? next()
      : res
          .status(503)
          .json({
            error:
              "Applications are temporarily unavailable. Please try again later.",
          });
  const readJSON = async (key) => {
    const data = await storage.get(key);
    return data ? JSON.parse(data.toString()) : null;
  };
  async function records(prefix, suffix = ".json") {
    const keys = (await storage.list(prefix)).filter((key) =>
      key.endsWith(suffix),
    );
    const result = [];
    for (let i = 0; i < keys.length; i += 20)
      result.push(...(await Promise.all(keys.slice(i, i + 20).map(readJSON))));
    return result.filter(Boolean);
  }
  const limiter = (limit, windowMs, error) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error },
    });
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.get("/api/positions", needStorage, async (req, res) =>
    res.json({
      positions: (await records("positions/"))
        .filter((role) => role.open)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_PDF,
      files: 1,
      fields: 6,
      fieldSize: 1000,
      parts: 7,
    },
  });
  app.post(
    "/api/applications",
    needStorage,
    limiter(10, 3600000, "Too many submissions. Please try again in an hour."),
    upload.single("resume"),
    async (req, res) => {
      if (req.body.website)
        throw fail(400, "Unable to accept this application.");
      const name = text(req.body.name, 120),
        email = text(req.body.email, 254),
        phone = text(req.body.phone, 40),
        roleId = text(req.body.role, 100);
      const fields = {};
      if (!name) fields.name = "Enter your full name.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        fields.email = "Enter a valid email address.";
      if (
        !/^[+\d\s().-]+$/.test(phone) ||
        !/^\d{7,15}$/.test(phone.replace(/\D/g, ""))
      )
        fields.phone = "Enter a valid phone number (7–15 digits).";
      let role =
        roleId === "general"
          ? { id: "general", title: "General application" }
          : UUID.test(roleId)
            ? await readJSON(`positions/${roleId}.json`)
            : null;
      if (!role || (roleId !== "general" && !role.open))
        fields.role =
          "This role is no longer open. Choose another role or a general application.";
      const file = req.file;
      if (
        !file ||
        !/\.pdf$/i.test(file.originalname) ||
        file.buffer.subarray(0, 5).toString() !== "%PDF-"
      )
        fields.resume = "Upload a valid PDF résumé, up to 5 MB.";
      else {
        try {
          const pdf = await PDFDocument.load(file.buffer, {
            throwOnInvalidObject: true,
          });
          if (!pdf.getPageCount()) throw new Error();
        } catch {
          fields.resume =
            "This PDF could not be read. Upload a valid, unencrypted PDF.";
        }
      }
      if (Object.keys(fields).length)
        throw fail(400, "Please check the highlighted fields.", fields);
      const createdAt = new Date(now()).toISOString(),
        date = createdAt.slice(0, 10),
        id = `${date}_${randomUUID()}`;
      const prefix = `applications/${date}/${id}/`;
      const details = {
        id,
        name,
        email,
        phone,
        roleId: role.id,
        roleTitle: role.title,
        createdAt,
      };
      await storage.put(`${prefix}resume.pdf`, file.buffer, "application/pdf");
      try {
        await storage.put(`${prefix}details.json`, JSON.stringify(details));
      } catch (error) {
        await storage.delete(`${prefix}resume.pdf`).catch(() => {});
        throw error;
      }
      res.status(201).json({ id, name, roleTitle: role.title });
    },
  );
  app.get("/api/admin/session", (req, res, next) => {
    if (!enabled()) return res.json({ enabled: false, authenticated: false });
    if (!req.cookies.admin_session)
      return res.json({ enabled: true, authenticated: false });
    authenticate(req, res, () =>
      res.json({
        enabled: true,
        authenticated: true,
        storageConfigured: !!storage,
      }),
    );
  });
  app.post(
    "/api/admin/login",
    limiter(
      10,
      900000,
      "Too many sign-in attempts. Please try again in 15 minutes.",
    ),
    (req, res) => {
      if (!enabled())
        return res
          .status(503)
          .json({ error: "Admin access is not configured." });
      if (
        typeof req.body.password !== "string" ||
        !same(req.body.password, env.ADMIN_PASSWORD)
      )
        return res.status(401).json({ error: "Incorrect password." });
      const payload = Buffer.from(
        JSON.stringify({ exp: now() + 12 * 3600000, nonce: randomUUID() }),
      ).toString("base64url");
      res
        .cookie("admin_session", `${payload}.${signature(payload)}`, {
          ...cookieOptions,
          maxAge: 12 * 3600000,
        })
        .json({ ok: true });
    },
  );
  app.post("/api/admin/logout", (req, res) =>
    res.clearCookie("admin_session", cookieOptions).json({ ok: true }),
  );
  app.use("/api/admin", authenticate, needStorage);
  app.get("/api/admin/positions", async (req, res) =>
    res.json({
      positions: (await records("positions/")).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
  );
  async function saveRole(req, res) {
    const id = req.params.id || randomUUID();
    if (!UUID.test(id)) throw fail(400, "Invalid position.");
    const old = req.params.id ? await readJSON(`positions/${id}.json`) : null;
    if (req.params.id && !old) throw fail(404, "Position not found.");
    const title = text(req.body.title, 120),
      location = text(req.body.location, 120),
      description = text(req.body.description, 10000),
      type = req.body.type;
    if (
      !title ||
      !location ||
      !description ||
      !TYPES.includes(type) ||
      typeof req.body.open !== "boolean"
    )
      throw fail(400, "Complete all position fields with valid values.");
    const role = {
      id,
      title,
      location,
      description,
      type,
      open: req.body.open,
      createdAt: old?.createdAt || new Date(now()).toISOString(),
    };
    await storage.put(`positions/${id}.json`, JSON.stringify(role));
    res.status(old ? 200 : 201).json(role);
  }
  app.post("/api/admin/positions", saveRole);
  app.put("/api/admin/positions/:id", saveRole);
  app.delete("/api/admin/positions/:id", async (req, res) => {
    if (!UUID.test(req.params.id)) throw fail(400, "Invalid position.");
    await storage.delete(`positions/${req.params.id}.json`);
    res.json({ ok: true });
  });
  app.get("/api/admin/applications", async (req, res) => {
    let applications = (await records("applications/", "/details.json")).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
    const roles = [
      ...new Map(
        applications.map((a) => [
          a.roleId,
          { id: a.roleId, title: a.roleTitle },
        ]),
      ).values(),
    ];
    const q = text(req.query.q, 254).toLowerCase(),
      role = text(req.query.role, 100);
    if (q)
      applications = applications.filter((a) =>
        [a.name, a.email, a.phone].some((value) =>
          value.toLowerCase().includes(q),
        ),
      );
    if (role) applications = applications.filter((a) => a.roleId === role);
    const total = applications.length,
      page = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json({
      applications: applications.slice((page - 1) * 25, page * 25),
      roles,
      total,
      page,
    });
  });
  const appPrefix = (id) => {
    if (!APP_ID.test(id)) throw fail(400, "Invalid application.");
    return `applications/${id.slice(0, 10)}/${id}/`;
  };
  app.get("/api/admin/applications/:id/resume", async (req, res) => {
    const data = await storage.get(`${appPrefix(req.params.id)}resume.pdf`);
    if (!data) throw fail(404, "Résumé not found.");
    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="resume.pdf"',
      })
      .send(data);
  });
  app.delete("/api/admin/applications/:id", async (req, res) => {
    const prefix = appPrefix(req.params.id);
    await storage.delete(`${prefix}resume.pdf`);
    await storage.delete(`${prefix}details.json`);
    res.json({ ok: true });
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
  app.get("/robots.txt", (req, res) =>
    res
      .type("text")
      .send(
        `User-agent: *\nDisallow: /admin\nDisallow: /api\nSitemap: ${(env.SITE_URL || "https://srijanlabs.in").replace(/\/$/, "")}/sitemap.xml\n`,
      ),
  );
  app.get("/favicon.ico", (req, res) => res.status(204).end());
  app.get("/sitemap.xml", (req, res) => {
    const base = (env.SITE_URL || "https://srijanlabs.in")
      .replace(/\/$/, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;");
    res
      .type("xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/contact.html", "/apply"].map((p) => `<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`,
      );
  });
  // Explicit public routes: never expose source, credentials, tests, or bucket data.
  for (const [url, file] of Object.entries({
    "/": "index.html",
    "/index.html": "index.html",
    "/contact.html": "contact.html",
    "/apply": "hiring/apply.html",
    "/admin": "hiring/admin.html",
  }))
    app.get(url, (req, res) => res.sendFile(path.join(root, file)));
  app.use(
    "/hiring",
    express.static(path.join(root, "hiring"), {
      index: false,
      dotfiles: "deny",
    }),
  );
  app.use(
    "/assets",
    express.static(path.join(root, "assets"), {
      index: false,
      dotfiles: "deny",
    }),
  );
  for (const name of ["logo.png", "srijan-labs.png", "srijan-labs-1.png"])
    app.get(`/${name}`, (req, res) => res.sendFile(path.join(root, name)));
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError)
      return res
        .status(400)
        .json({
          error:
            error.code === "LIMIT_FILE_SIZE"
              ? "Your résumé must be 5 MB or smaller."
              : "Upload one PDF and complete only the application fields.",
          fields: { resume: "Upload one PDF, up to 5 MB." },
        });
    if (!error.status) console.error("Request failed:", error.name);
    res
      .status(error.status || 503)
      .json({
        error: error.status
          ? error.message
          : "Service temporarily unavailable. Please try again later.",
        ...(error.fields ? { fields: error.fields } : {}),
      });
  });
  return app;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  createApp().listen(process.env.PORT || 3000, "0.0.0.0", () =>
    console.log(`Srijan Labs: http://localhost:${process.env.PORT || 3000}`),
  );
