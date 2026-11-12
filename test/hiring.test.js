import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../server.js";

const password = "test-password-only-123";
function fixture() {
  const objects = new Map();
  const storage = {
    async put(k, v) {
      objects.set(k, Buffer.from(v));
    },
    async get(k) {
      return objects.get(k) || null;
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
    async delete(k) {
      objects.delete(k);
    },
  };
  const env = { ADMIN_PASSWORD: password, SITE_URL: "http://localhost" };
  let time = Date.now();
  return {
    objects,
    storage,
    env,
    advance(ms) {
      time += ms;
    },
    app: createApp({ env, storage, now: () => time }),
  };
}
async function pdf() {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save());
}
async function login(app) {
  const agent = request.agent(app);
  await agent.post("/api/admin/login").send({ password }).expect(200);
  return agent;
}
function submit(app, buffer, role = "general", values = {}) {
  let req = request(app).post("/api/applications");
  for (const [key, value] of Object.entries({
    name: "Test Applicant",
    email: "applicant@example.com",
    phone: "+91 9876543210",
    role,
    website: "",
    ...values,
  }))
    req = req.field(key, value);
  return req.attach("resume", buffer, "resume.pdf");
}
const position = {
  title: "Frontend Developer",
  location: "Remote",
  type: "Full-time",
  description: "Build useful tools.",
  open: true,
};

test("full lifecycle: publish, submit, search, download, close, delete role without losing applications", async () => {
  const f = fixture(),
    admin = await login(f.app),
    bytes = await pdf();
  const role = (
    await admin.post("/api/admin/positions").send(position).expect(201)
  ).body;
  assert.equal(
    (await request(f.app).get("/api/positions")).body.positions[0].title,
    position.title,
  );
  const application = (await submit(f.app, bytes, role.id).expect(201)).body;
  assert.equal(
    [...f.objects.keys()].filter((k) => k.includes("/resume.pdf")).length,
    1,
  );
  const list = await admin
    .get("/api/admin/applications?q=APPLICANT&role=" + role.id)
    .expect(200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.applications[0].roleTitle, position.title);
  const download = await admin
    .get(`/api/admin/applications/${application.id}/resume`)
    .expect(200);
  assert.equal(download.headers["content-type"], "application/pdf");
  assert.deepEqual(download.body, bytes);
  await request(f.app)
    .get(`/api/admin/applications/${application.id}/resume`)
    .expect(401);
  await admin
    .put(`/api/admin/positions/${role.id}`)
    .send({ ...position, open: false })
    .expect(200);
  assert.equal(
    (await request(f.app).get("/api/positions")).body.positions.length,
    0,
  );
  await submit(f.app, bytes, role.id).expect(400);
  await admin.delete(`/api/admin/positions/${role.id}`).expect(200);
  assert.equal((await admin.get("/api/admin/applications")).body.total, 1);
  await admin.delete(`/api/admin/applications/${application.id}`).expect(200);
  assert.equal(f.objects.size, 0);
});
test("general applications use unique dated folders", async () => {
  const f = fixture(),
    bytes = await pdf();
  const first = (await submit(f.app, bytes).expect(201)).body;
  const second = (await submit(f.app, bytes).expect(201)).body;
  assert.notEqual(first.id, second.id);
  assert.equal(f.objects.size, 4);
  assert.ok(
    [...f.objects.keys()].every((k) =>
      /^applications\/\d{4}-\d{2}-\d{2}\//.test(k),
    ),
  );
});
test("rejects renamed files, fake PDF headers, encrypted/empty malformed PDFs, oversized PDFs and bots", async () => {
  const f = fixture();
  await submit(f.app, Buffer.from("not a PDF")).expect(400);
  await submit(f.app, Buffer.from("%PDF-1.7\nthis is not a PDF")).expect(400);
  await submit(f.app, Buffer.alloc(5 * 1024 * 1024 + 1)).expect(400);
  await submit(f.app, await pdf(), "general", { website: "spam" }).expect(400);
  assert.equal(f.objects.size, 0);
});
test("validates every applicant field and stale/unknown roles", async () => {
  const f = fixture(),
    bytes = await pdf();
  const result = await submit(f.app, bytes, "invented", {
    name: "",
    email: "bad",
    phone: "abc",
  }).expect(400);
  assert.deepEqual(Object.keys(result.body.fields).sort(), [
    "email",
    "name",
    "phone",
    "role",
  ]);
  await submit(f.app, bytes, "general", { name: "x".repeat(121) }).expect(400);
});
test("application rate limit stops attempt eleven even with spoofed forwarded headers", async () => {
  const f = fixture(),
    bytes = await pdf();
  for (let i = 0; i < 10; i++) await submit(f.app, bytes).expect(201);
  await submit(f.app, bytes).set("X-Forwarded-For", "203.0.113.99").expect(429);
});
test("sessions expire at 12 hours and password rotation invalidates existing sessions", async () => {
  const f = fixture(),
    admin = await login(f.app);
  await admin.get("/api/admin/session").expect(200);
  f.advance(12 * 3600000 + 1);
  await admin.get("/api/admin/session").expect(401);
  const second = await login(f.app);
  f.env.ADMIN_PASSWORD = "another-long-password";
  await second.get("/api/admin/session").expect(401);
});
test("logout clears session, login is rate limited, and cross-origin writes fail", async () => {
  const f = fixture(),
    admin = await login(f.app);
  await admin.post("/api/admin/logout").expect(200);
  await admin.get("/api/admin/positions").expect(401);
  await request(f.app)
    .post("/api/admin/login")
    .set("Origin", "https://attacker.example")
    .send({ password })
    .expect(403);
  for (let i = 0; i < 9; i++)
    await request(f.app)
      .post("/api/admin/login")
      .send({ password: "wrong" })
      .expect(401);
  await request(f.app).post("/api/admin/login").send({ password }).expect(429);
});
test("missing storage and short password fail closed; static routes never expose source", async () => {
  const app = createApp({ env: { ADMIN_PASSWORD: "short" }, storage: null });
  assert.equal(
    (await request(app).get("/api/admin/session")).body.enabled,
    false,
  );
  await request(app)
    .post("/api/admin/login")
    .send({ password: "short" })
    .expect(503);
  await request(app).get("/api/positions").expect(503);
  await request(app).post("/api/applications").expect(503);
  for (const route of [
    "/.env",
    "/server.js",
    "/package.json",
    "/.git/config",
    "/storage.js",
  ])
    await request(app).get(route).expect(404);
  for (const route of ["/", "/contact.html", "/apply", "/admin"])
    await request(app).get(route).expect(200);
  assert.match(
    (await request(app).get("/robots.txt")).text,
    /Disallow: \/admin/,
  );
  assert.match((await request(app).get("/sitemap.xml")).text, /\/apply/);
});
test("metadata storage failure cleans up resume and never returns success", async () => {
  const f = fixture(),
    originalPut = f.storage.put;
  f.storage.put = async (key, value, type) => {
    if (key.endsWith("details.json"))
      throw new Error("Simulated storage failure");
    await originalPut(key, value, type);
  };
  await submit(f.app, await pdf()).expect(503);
  assert.equal(f.objects.size, 0);
});
test("production sessions have secure cookie attributes", async () => {
  const app = createApp({
    env: { ADMIN_PASSWORD: password, NODE_ENV: "production" },
    storage: null,
  });
  const response = await request(app)
    .post("/api/admin/login")
    .send({ password })
    .expect(200);
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
  assert.match(response.headers["set-cookie"][0], /Secure/);
  assert.match(response.headers["set-cookie"][0], /SameSite=Strict/);
});
