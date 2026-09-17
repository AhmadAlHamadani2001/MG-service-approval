# MG Service Approval — local build

A fully working version of the MG after-sales service approval workflow:
real login, a real API, real state-machine rules enforced on the server,
bilingual English/Arabic UI with RTL support, and data that survives
restarts. It runs entirely on your machine — no cloud database, no build
step, no Docker required.

## Prerequisites

- [Node.js](https://nodejs.org) 18 or newer (check with `node -v`)
- An internet connection the first time the page loads, so the browser can
  fetch Tailwind CSS and the Google Fonts (Poppins / Inter / Cairo / IBM
  Plex Mono) from their CDNs. Everything else — the server, the API, the
  data — runs fully offline.

That's it. Data is stored in a local JSON file (`server/data.json`), created
automatically the first time you run the app.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:4000** in your browser.

Use `npm run dev` instead of `npm start` if you have `nodemon` available and
want the server to restart automatically when you edit files.

## Troubleshooting

- **"Error: listen EADDRINUSE: address already in use :::4000"** — a
  previous copy of this server is still running (often in another terminal
  window you forgot about). Either stop that process, or run this one on a
  different port: `set PORT=4001 && npm run dev` on Windows (or
  `PORT=4001 npm run dev` on macOS/Linux), then open
  `http://localhost:4001` instead.
- **Fewer demo accounts than expected, or anything else looking out of
  date** — two separate causes:
  1. Your browser cached an older page. Hard refresh (Ctrl/Cmd + Shift + R)
     or open the app in a new incognito/private window.
  2. `server/data.json` already existed from an earlier run of this app in
     the same folder (a very old version, if it predates the current 5
     roles). As of this version, the server checks for that on startup and
     rebuilds automatically if the file looks outdated — you'll see a
     console message like `[mg-approval] server/data.json is from an older,
     incompatible version...` when that happens, which is expected and
     harmless. If for some reason it doesn't self-correct, you can always
     force it by stopping the server and deleting the file yourself
     (`del server\data.json` on Windows, `rm server/data.json` on
     macOS/Linux) before starting it again.
- **A demo account "won't log in"** — the password is
  **`password123`, all lowercase**, and login is case-sensitive (this is
  intentional — it's the same check a real login would use). Easiest fix:
  click the one-click account button on the login screen instead of typing
  the email/password by hand; it always fills in the exact right values.

## Demo accounts

The login screen has one-click buttons for all five, or use these directly
— password is the same for all of them (all lowercase):

| Role                | Email                              | Password      |
|---------------------|--------------------------------------|----------------|
| Sales Representative | `sales@mg-demo.local`               | `password123`  |
| Sales Manager         | `sales.manager@mg-demo.local`       | `password123`  |
| Finance Approver     | `finance@mg-demo.local`             | `password123`  |
| Aftersales Admin     | `aftersales.admin@mg-demo.local`    | `password123`  |
| Aftersales Team      | `aftersales.team@mg-demo.local`     | `password123`  |

**Aftersales Admin** vs **Aftersales Team** are deliberately separate roles:

- **Aftersales Admin** manages the service catalog only — creating services,
  editing prices and labor hours, deactivating/reactivating items, and
  setting each service's **approval level** (see below). This role has no
  access to service requests at all.
- **Aftersales Team** works the request queue — estimation, comments,
  execution, closing requests, and submitting walk-in estimates. This role
  has no access to the catalog.

**Sales Representative** vs **Sales Manager** are also separate roles:

- **Sales Representative** builds and submits new requests, and corrects
  their own requests when they're sent back. They no longer approve
  anything themselves.
- **Sales Manager** is the first approval stage for every request — both
  Sales-originated and Aftersales walk-ins — and decides whether it needs
  Finance's sign-off too, or can go straight to Aftersales.

Log in as several of these in separate browser windows (or one regular +
one incognito) to watch a request move across roles in real time (reload to
refresh each window).

## The workflow (SOP)

Every request — however it enters the system — is reviewed by the **Sales
Manager** first. The Sales Manager decides whether their own approval is
enough, or whether Finance also needs to sign off, based on the **approval
level** of the services on the request (set by the Aftersales Admin on each
catalog item — see "Approval levels" below).

There are two ways a request enters the system:

**1. Sales-originated**

```
Sales Rep fills the request, picks services, submits
        │
        ▼
Sales Manager reviews  →  APPROVE ────────────────────────────────┐
        │                                                         │
        ├─ REJECT → closed, no further action                    │
        │                                                         │
        ├─ RETURN → back to the Sales Rep to correct               │
        │   (Sales Rep edits and resubmits — to the Sales           │
        │    Manager again, since they never approved it)            │
        │                                                         │
        └─ if every service on the request is "Sales Manager"       │
           level, their approval alone is enough — skip straight     │
           to Aftersales for execution ─────────────────────────────┤
                                                                    ▼
                                          Otherwise: Finance reviews next
                                                                    │
                                          Finance  →  APPROVE ──────┤
                                              │                     │
                                              ├─ REJECT → closed    │
                                              │                     │
                                              ├─ RETURN → back to    │
                                              │   the Sales Rep to    │
                                              │   correct (resubmit    │
                                              │   goes straight back    │
                                              │   to Finance, since the  │
                                              │   Sales Manager already   │
                                              │   approved it once)        │
                                              │                     │
                                              └─ DELEGATE → Aftersales │
                                                   Team estimates       │
                                                   (adds/removes          │
                                                    services, adds a       │
                                                    comment, resubmits       │
                                                    to Finance) ──────────────┤
                                                                            ▼
                                                       Aftersales Team is assigned
                                                       to execute: starts the job,
                                                       adds comments, closes it
```

**2. Walk-in / Aftersales-originated**

Sometimes the vehicle shows up directly at Aftersales with no prior Sales
request. The shape is the same, except the Aftersales Team submits the
estimate and the Sales Manager (not the Sales Rep) is the one who reviews
it — and a returned walk-in goes back to the Aftersales Team, not Sales:

```
Aftersales Team builds the estimate directly and submits it — to the
        Sales Manager
        │
        ▼
Sales Manager reviews  →  APPROVE  →  (same approval-level split as above:
        │                              straight to Aftersales, or on to
        │                              Finance first)
        ├─ REJECT → closed
        │
        └─ RETURN → back to the Aftersales Team to correct and
              resubmit (to the Sales Manager again, or straight to
              Finance if the Sales Manager had already approved it once)
```

A walk-in-origin request can't be delegated by Finance back to Aftersales
(it's already their estimate) — Finance can only approve, reject, or return
it to Aftersales for correction.

### Approval levels

Every service in the catalog has an **approval level**: `Finance` or `Sales
Manager`, set by the Aftersales Admin when creating or editing it (also
available as a column in the bulk-import CSV). When the Sales Manager
reviews a request, the server computes its effective level from its active
line items: if **every** item is `Sales Manager`-level, the Sales Manager's
own approval is final and the request skips Finance entirely; if **any**
item is `Finance`-level, the request still needs Finance's sign-off after
the Sales Manager approves it. This lets routine, low-value repairs move
straight to execution while anything requiring Finance's attention still
gets it.

### Status values

`PENDING_SALES_APPROVAL` → `PENDING_FINANCE_APPROVAL` → `UNDER_AFTER_SALES_ESTIMATION`
→ `RETURNED_TO_SALES` / `RETURNED_TO_AFTERSALES` → `APPROVED_IN_AFTER_SALES`
→ `CLOSED`, with `REJECTED` reachable from either approval stage.
(`PENDING_SALES_APPROVAL` is now reviewed by the Sales Manager rather than
the Sales Rep — the status name is unchanged so existing history/audit data
stays consistent.)

## What's actually implemented

- **Auth** — real login, bcrypt-hashed passwords, JWT sessions (`server/auth.js`).
- **RBAC** — every endpoint checks role; the state machine (`server/stateMachine.js`)
  checks the request's current status before allowing a transition, so you
  can't approve a request that's already been rejected, delegate a walk-in
  request, or close a job execution hasn't started on, etc.
- **Full dual-origin workflow** — submit (Sales Rep or Aftersales walk-in),
  Sales Manager approve/reject/return (approval-level aware — skips Finance
  when every item is Sales-Manager-level), Finance approve/reject/return/
  delegate, Aftersales estimation (add/remove line items, comments),
  resubmit, execution start, close — all origin-aware.
- **Service catalog CRUD** — create, edit, deactivate/reactivate, permanently
  delete (only if a service has never been used on a request — otherwise
  you're told to deactivate it instead so history stays intact), and bulk
  import via a downloadable CSV template. Restricted to the Aftersales Admin
  role only. Each service also carries an **approval level** (`Finance` or
  `Sales Manager`) that drives the routing above.
- **Comments & audit trail** — free-form comments any involved role can add
  to a request (shown with the author's job title/role, not just their
  name), and a full per-request status-change timeline (same — actor's role
  shown next to their name).
- **Deleted line items stay visible** — when the Aftersales Team removes a
  line item during estimation, it isn't hidden; it stays in the list, greyed
  out and labeled "Deleted", so everyone reviewing the request can see what
  changed.
- **Clickable stat tiles** — on the Finance and Sales Manager dashboards, the
  summary numbers (Pending, Estimation, Returned, Approved/Closed, etc.) are
  buttons: click one to switch the queue below into a read-only review list
  of exactly those cases, with a "back to queue" link to return to the
  normal actionable queue.
- **Price/labor snapshots** — line items freeze the catalog price (shown in
  SR) at the moment they're added.
- **Notes on submission** — Sales can attach an optional note when creating a
  new request; it's stored as the first comment on the request's timeline.
- **Search** — Sales can search the service catalog by name/code while
  building a new request, and search their own request history by VIN or
  request number.
- **Sales workspace tabs** — "New Service Request" (the submission form plus
  a short list of their own requests bounced back for correction) and a
  separate "My Requests" tab with the full searchable history.
- **Aftersales Team "walk-in" panel is a button, not an always-open form** —
  it starts collapsed; clicking it opens the submission form, and it
  collapses again after a successful submit.
- **VIN as the primary subject on the Aftersales Team page** — the
  Estimation Queue, Execution Queue, and Direct Estimates lists all lead
  with the VIN (request number shown secondary), since that's how the shop
  floor identifies a vehicle.
- **Bilingual UI (English / Arabic)** — a language toggle on every screen
  (including the login screen), full RTL layout mirroring, and an Arabic
  font stack (Cairo/Tajawal) that swaps in automatically.
- **MG-branded, golden-ratio enterprise design** — a light, airy foundation
  throughout, with translucent white glass panels (blur + layered shadow) for
  the working area, masked gradient border glow accents, a subtle
  noise-texture overlay, and a spacing scale built on the golden ratio
  (~1.618×). Built with Tailwind CSS and the real MG octagon/badge marks.

## Try/debug ideas

- Submit a request as Sales Rep, then log in as Sales Manager in another
  window and watch it appear in the approval queue immediately (reload to
  refresh).
- As Aftersales Admin, set a service's approval level to **Sales Manager**,
  build a Sales request using only that service, then approve it as Sales
  Manager — it should jump straight to `APPROVED_IN_AFTER_SALES` without
  ever touching Finance's queue. Do the same with a **Finance**-level
  service and watch it land in Finance's queue instead.
- As Sales Manager, **Approve** a request that needs Finance, then as
  Finance, **Delegate to Aftersales**, then switch to the Aftersales Team
  account, open the **Estimation** tab, remove a line item, leave a
  comment, and **Resubmit to Finance** — the removed item should still show
  up (greyed out, labeled "Deleted") for everyone who reviews that request
  afterward, and the request lands back in Finance's queue with the
  updated total.
- As Aftersales Team, submit a **Walk-in Vehicle Estimate** (now a
  collapsed button — click it to open the form) — it should appear in the
  Sales Manager's approval queue, not the Sales Rep's.
- On the Finance or Sales Manager dashboard, click a stat tile other than
  the default queue (e.g. "Returned" or "Approved / closed") — the list
  below should switch to a read-only review of just those cases, with a
  "back to queue" link to return.
- Try to **close** a request before starting execution — the server should
  reject it with a clear error instead of silently allowing it.
- Try an invalid action from the wrong role or wrong state (e.g. calling the
  API directly) — the server responds with a 403/409 and a plain-English
  reason instead of silently doing the wrong thing.
- Toggle **EN / AR** at any point, including mid-session — the whole layout
  should mirror to RTL and all labels should translate.
- As Aftersales Admin, click **Bulk Import**, download the CSV template,
  add a couple of rows (including the `approvalLevel` column), and upload
  it — valid rows are created, and rows with a duplicate code or missing
  fields are listed as skipped with a reason instead of failing the whole
  batch.
- As Aftersales Admin, try to **Delete** a service that's already on a
  request (any of the seeded ones) — it should be blocked with a message
  telling you to deactivate instead; deleting a brand-new, never-used
  service should work and remove it for good.
- `npm run seed:reset` wipes `server/data.json` back to the original demo
  data if you want a clean slate.

## Project structure

```
webapp/
├── server/
│   ├── index.js          Express app entry point (API + static frontend)
│   ├── db.js              JSON-file data store + demo seed data (5 users,
│   │                       10 services incl. approval level, sample
│   │                       requests incl. a walk-in)
│   ├── auth.js             JWT signing/verification, auth middleware
│   ├── stateMachine.js      Transition guards, history, audit logging
│   ├── reset.js              CLI: restore seed data
│   └── routes/
│       ├── auth.js            POST /api/auth/login, GET /api/auth/me
│       ├── services.js         Service catalog CRUD (Aftersales Admin only)
│       ├── requests.js          Full request lifecycle + actions
│       └── audit.js              System-wide audit log
└── public/
    ├── index.html          Single-page shell (Tailwind CDN + config)
    ├── styles.css           MG design system: golden-ratio spacing, glass
    │                         panels, noise overlay, masked border glow
    ├── i18n.js               English/Arabic string dictionaries + helpers
    ├── app.js                All frontend logic, no framework/build step
    └── assets/                MG octagon logo + badge artwork
```

## Key API endpoints

| Method | Path                                    | Role(s)                     | Notes                                    |
|--------|------------------------------------------|-------------------------------|--------------------------------------------|
| POST   | `/api/requests`                          | Sales                        | Create a normal request (`origin: SALES`)   |
| POST   | `/api/requests/walk-in`                  | Aftersales Team              | Create a walk-in estimate (`origin: WALK_IN`) |
| PATCH  | `/api/requests/:id/resubmit`             | Sales                        | Resubmit after `RETURNED_TO_SALES` (destination: Sales Manager, or straight to Finance if the Sales Manager already approved it once) |
| POST   | `/api/requests/:id/sales-manager-approve`| Sales Manager                 | Approve — routes to Finance, or straight to Aftersales if every item is Sales-Manager-level |
| POST   | `/api/requests/:id/sales-manager-reject` | Sales Manager                 | Reject                                        |
| POST   | `/api/requests/:id/sales-manager-return` | Sales Manager                 | Return (destination depends on origin: Sales Rep or Aftersales Team) |
| POST   | `/api/requests/:id/approve`              | Finance                      | Approve                                       |
| POST   | `/api/requests/:id/reject`               | Finance                      | Reject                                        |
| POST   | `/api/requests/:id/return`               | Finance                      | Return (destination depends on origin)        |
| POST   | `/api/requests/:id/delegate`             | Finance                      | Delegate to Aftersales (blocked on walk-ins)  |
| PATCH  | `/api/requests/:id/estimation-items`     | Aftersales Team              | Add/remove line items during estimation (removed items keep `itemStatus: REMOVED`, they're never deleted from the response) |
| PATCH  | `/api/requests/:id/resubmit-estimate`    | Aftersales Team              | Resubmit after `RETURNED_TO_AFTERSALES` (same Sales-Manager-or-Finance destination logic as `/resubmit`) |
| POST   | `/api/requests/:id/resubmit-to-finance`  | Aftersales Team              | Send the estimate to Finance                  |
| POST   | `/api/requests/:id/start-execution`      | Aftersales Team              | Begin the physical job                        |
| POST   | `/api/requests/:id/close`                | Aftersales Team              | Close (requires execution already started)     |
| POST   | `/api/requests/:id/comments`             | any role with request access | Add a free-form comment                        |
| GET    | `/api/requests/:id/audit-log`            | Finance, Aftersales Team, Sales Manager | Per-request history (not currently surfaced in the UI) |
| GET    | `/api/services`                          | all roles                    | List catalog (active only, unless Admin)       |
| POST/PATCH   | `/api/services...`                 | Aftersales Admin              | Create / edit / deactivate / reactivate — includes `approvalLevel` (`FINANCE` or `SALES_MANAGER`) |
| DELETE | `/api/services/:id`                      | Aftersales Admin              | Permanent delete (409 if used on any request)   |
| POST   | `/api/services/bulk-import`              | Aftersales Admin              | Create many services from parsed CSV rows (optional `approvalLevel` column, defaults to `FINANCE`) |

## Deploying for real use

Two environment variables switch this from a local demo into something safe
to run for real, concurrent staff use — see `.env.example` for details:

- **`DATABASE_URL`** — a Postgres connection string. When set, all data
  (users, requests, vehicles, everything) is stored in that Postgres
  database instead of the local `server/data.json` file, which is required
  on any host with an ephemeral filesystem (Render's free tier included —
  the local file would be wiped on every restart/redeploy). When unset, the
  app runs exactly as it does locally, with zero extra setup.
- **`JWT_SECRET`** — a long random secret used to sign login sessions
  (generate one with `openssl rand -hex 32`). In production
  (`NODE_ENV=production`) the app refuses to start without one, rather than
  silently signing sessions with the demo default that ships in this repo.

`render.yaml` is a ready-to-use [Render](https://render.com) Blueprint —
push this repo to GitHub, then in Render choose **New +** → **Blueprint**
and point it at the repo. It provisions the web service and generates a
`JWT_SECRET` automatically; you still need to set `DATABASE_URL` yourself
(from your Postgres provider, e.g. Supabase) in the service's Environment
tab.

Every demo account's password is still `password123` until each person
changes it themselves with the **Change Password** button in the header —
do that for every real account before handing this to staff.

Frontend note: this is still plain JS with manual DOM rendering and
Tailwind loaded from its CDN (needs internet access on first load) — chosen
so nothing needs a build step. That's independent of the storage/secrets
change above and doesn't need to change to go live.
