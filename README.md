# Srijan Labs website

The existing marketing and Formspree contact pages now run alongside a Node/Express hiring service. Run **one server replica** for the process-local submission and login limits.

## Run locally

For a self-contained preview with two sample positions and files saved in the ignored `local-data/` folder, run `npm run preview:local` and open `http://localhost:3002/apply`. The admin page is at `http://localhost:3002/admin`, with local-only password `local-preview-123`. Override it with `LOCAL_ADMIN_PASSWORD` if desired. The preview binds to localhost and uses separate local data, never the Railway bucket.

Requires Node 22 or newer.

```sh
npm ci
# Copy .env.example to .env, then supply your private bucket credentials and password.
npm start
```

Open `http://localhost:3000/apply` or `/admin`. Set `SITE_URL=http://localhost:3000` for local testing. The server starts without credentials, but applications remain unavailable and admin is disabled until configured. It never silently saves applications to temporary disk or fake storage.

## Railway deployment

Deploy this repository as a Node service, not as a static site. `railway.json` sets the start command and `/health` check. Supply:

- `NODE_ENV=production`
- `SITE_URL` — exact public origin, e.g. `https://srijanlabs.in`
- `ADMIN_PASSWORD` — at least 10 characters; use a strong unique password
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — from a private Railway bucket
- `S3_REGION=auto` (override if required by the bucket provider)
- `TRUST_PROXY` — verified proxy hop count (typically `1` for direct Railway hosting); do not use unrestricted proxy trust

Keep the bucket private. Credentials need list/get/put/delete access. Do not place secrets in frontend JavaScript or commit `.env`. Test through the intended public domain, including the proxy-derived client IP, before accepting real applications. A different preview domain must use its own `SITE_URL` or a matching environment. The app listens on Railway's `PORT`.

No email notification or applicant confirmation email is sent by this feature. Successful submissions show an on-page confirmation. The existing contact form still uses Formspree.

## Data and security

- `positions/<uuid>.json`: one durable record per role.
- `applications/YYYY-MM-DD/YYYY-MM-DD_<uuid>/resume.pdf` and `details.json`: UTC date partition and unique application identifier.
- Role title is captured at submission so role edits/deletion do not erase historical applications.
- Uploads are limited to 5 MiB, checked for PDF signature and parsed for valid, unencrypted PDF pages. Parsing verifies PDF structure; it is not antivirus scanning.
- Application metadata is written only after the résumé. A metadata failure attempts to remove the orphan résumé.
- Admin sessions are signed, HttpOnly, SameSite=Strict cookies lasting 12 hours; production cookies require HTTPS. Password rotation invalidates earlier sessions after the service receives the new value.
- Application attempts: 10 per IP per hour. Login attempts: 10 per IP per 15 minutes. These limits reset on restart and are not shared across replicas. Use a shared limiter before horizontal scaling.
- Same-origin write checks, protected download routes, no public storage URLs, and no caching of admin/API responses.
- Admin can permanently delete an application and its résumé to support retention/deletion requests. Set an internal retention schedule before collecting applications; the app does not automatically expire records.
- Applications are listed from object storage, fetched in bounded batches, then searched/paginated server-side. For high submission volume, introduce a database index rather than scanning all records. Concurrent edits to the same position use last-write-wins semantics.

## Verification

```sh
npm test
```

Integration tests inject an in-memory bucket adapter, generate real PDFs, and exercise role CRUD, submission, validation, rate limits, authenticated downloads, session expiry, password rotation, storage failures, and non-public source paths. They do not prove live Railway credentials or persistence: verify one authorized test application and download against the configured private bucket before launch.
