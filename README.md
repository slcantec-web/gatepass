# Gate Pass & Employee Movement Management System

A rebuild of the CanTec gate pass system on Cloudflare Pages + Workers + D1,
per the attached spec. Fresh build — no migration from the old
`cantecpass.gt.tc` PHP app.

## Stack

- **Frontend**: vanilla HTML/CSS/JS PWA (`index.html`, `js/*`, `css/*`, `sw.js`, `manifest.json`) → Cloudflare Pages
- **Backend**: Cloudflare Workers, no framework/bundler needed (`worker/src/*`)
- **Database**: Cloudflare D1 (`worker/schema/schema.sql`)
- **Files (optional)**: Cloudflare R2, not wired up yet — add when you need attachments/photos

## What's implemented (v1 scaffold)

- Schema: employees, departments, companies, locations, gate_passes, pass_members,
  pass_routes, movement_events, approvals, audit_log, users, sessions, system_settings
- Auth: PBKDF2 password hashing, HttpOnly/Secure/SameSite session cookies, RBAC guard
- Employee Master: list, create, bulk import with duplicate rejection
- Location Master: list, create (universal location model, typed)
- Create Movement Pass: group passes with independent per-member status, route
- HOD Approval: approve/reject pending passes
- Movements: GATE_OUT / LOCATION_IN / LOCATION_OUT / EXTERNAL_IN / EXTERNAL_OUT / RETURN / GATE_IN,
  with the full validation chain (auth → role → pass state → membership → duplicate check),
  atomic writes via `env.DB.batch()`, and idempotency keys
- Pass auto-completes only once every member has RETURNED (or been CANCELLED) — a straggler
  keeps the pass open, per spec section 5
- Live status dashboard (INSIDE / OUTSIDE / INTERNAL / EXTERNAL / OVERDUE)
- Audit log: every state-changing action is recorded and read-only in the UI
- Service worker caches the app shell only — API/movement calls always hit the network live
  (per spec section 23 — no silent offline queueing of gate transactions)

## Also implemented (phase 2)

- **QR codes**: every location and every approved pass carries a `qr_code_token`.
  Location Master and Pass Details have a "Show QR" button (rendered client-side via
  the `qrcode` CDN library). Security Gate Out/In and Location Check-In/Out have a
  "Scan QR" button that opens the camera (via `jsQR`), decodes the token, and calls
  `GET /api/qr/:token`, which resolves it to either a location or a pass — the scanner
  doesn't need to know in advance which kind it's pointed at.
- **User Management** screen: list users, create a user (username/password/role/linked
  employee), and activate/deactivate accounts. A non-Super-Admin can't create another
  Super Admin, and you can't deactivate your own account.
- **CSV/XLSX employee import**: file picker on Employee Master parses the file
  client-side (`PapaParse` for CSV, `SheetJS` for XLSX), normalizes common header
  variants (e.g. "Employee ID" → `emp_code`), shows a preview, and only imports on
  confirmation. Duplicate `emp_code` values are rejected per-row with the row number,
  never silently skipped or overwritten (section 20).

## Workers without a smartphone (e.g. drivers)

The self-service screens (Location Check-In/Out) assume the worker has their
own phone with the app open. For drivers or anyone without one:

- Every employee now gets a **badge QR token** (`employees.badge_qr_token`),
  generated the same way locations/passes get theirs.
- **Employee Master → "Print Worker Badges"** prints one small card per
  employee (QR + name + code) — laminate these as physical ID badges.
- **Security/Admin → "Assisted Check"** screen: staff scans the pass QR,
  then scans the worker's badge, then records the Location/External/Return
  event on the worker's behalf. No phone required on the driver's side.
- This works because the backend already lets Security/Admin record a
  movement event for *any* employee, not just themselves — the "Assisted
  Check" screen is just a UI for that permission, no backend change to
  the security rules was needed for it.
- Gate In/Out is already staff-operated for everyone (Security Gate Out/In
  screens), so no change was needed there.

If you'd rather use barcode/RFID cards instead of printed QR codes, the same
`badge_qr_token` can be encoded as a barcode instead — the resolve endpoint
(`GET /api/qr/:token`) doesn't care what symbology produced the token, only
that a scanner/reader hands it back as text.

## Not yet built (next phases, won't require changing the core model)

- Formal reports (section 22) — the audit log and live status endpoints give you the raw data;
  dedicated report queries can be layered on without touching movement_events
- R2 file attachments
- Geofence validation using `locations.latitude/longitude/geofence_radius`
- SAP B1 sync into the `sap_employee_id` / `sap_company` columns already on `employees`
- Printable/downloadable QR codes (currently shown on-screen only — add a "Download PNG"
  button on the QR modal, or print labels in bulk from Location Master)

## Local setup

```bash
cd worker
npm install -g wrangler   # if you don't have it already
wrangler login

# create the D1 database and copy the returned database_id into wrangler.toml
wrangler d1 create gate-pass-db

# apply the schema
wrangler d1 execute gate-pass-db --file=./schema/schema.sql

# create your first login (SUPER_ADMIN)
node schema/generate-admin-hash.js "YourStrongPassword" admin
# copy the printed INSERT statement, then:
wrangler d1 execute gate-pass-db --command="<paste the INSERT here>"

# run the worker locally
wrangler dev
```

## Deploying

```bash
# Worker
cd worker
wrangler deploy

# Frontend: push the repo root (index.html, css/, js/, manifest.json, sw.js) to GitHub
# and connect it to Cloudflare Pages. Point js/api.js's API_BASE (or set
# window.GATEPASS_API_BASE before app.js loads) at your deployed Worker URL,
# e.g. https://gate-pass-api.<your-subdomain>.workers.dev/api
```

Then in `worker/src/index.js`, tighten `Access-Control-Allow-Origin` from `*`
to your actual Pages domain before going live.

## Roles

`SUPER_ADMIN`, `ADMIN`, `HOD`, `EMPLOYEE`, `SECURITY`, `MANAGEMENT_VIEWER` — enforced
on every endpoint in `worker/src/index.js` via `requireRole()`.
