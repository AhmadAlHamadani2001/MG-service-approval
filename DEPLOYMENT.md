# Going live — deployment walkthrough

This app is now ready to run as a real, always-on service instead of just
on your own machine. Two things changed under the hood to make that safe:

1. **Storage**: it now stores its data in a real Postgres database instead
   of a local file, so nothing is lost when the server restarts or
   redeploys. (Locally, with no database configured, it still works exactly
   as before — nothing changes for `npm start` on your own machine.)
2. **Login secret**: it now requires a real, random secret to sign login
   sessions instead of the built-in demo one, once it's running in
   production.

Everything below is the last-mile setup only you can do (creating
accounts, approving connections) — I can't create accounts on your behalf.
Steps 1–2 use free tiers throughout.

## Step 1 — Create the database (Supabase)

1. Go to [supabase.com](https://supabase.com) and sign in (or create an
   account) with the account you want to own this app's database —
   `jmm.warrantyteam@jiadmotors.com`, since your personal account is
   already at its 2-project free-tier limit.
2. Click **New Project**. Name it something like `mg-service-approval`,
   set a database password (save it somewhere — you'll need it in a
   moment), and pick a region close to your dealership. Wait for it to
   finish provisioning (a minute or two).
3. Once it's ready, go to **Project Settings → Database → Connection
   string**, and switch to the **Session pooler** tab (not "Direct
   connection" — the direct host is IPv6-only, and most free hosts
   including Render can't reach it). Copy that connection string — it
   looks like:
   ```
   postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-xx-xxxx-x.pooler.supabase.com:5432/postgres
   ```
   Replace `[YOUR-PASSWORD]` with the database password from step 2. Save
   this full string somewhere — it's your `DATABASE_URL` for step 3.

The app will create its own table in this database automatically the
first time it starts — there's nothing to set up by hand in Supabase
beyond creating the project.

## Step 2 — Push the code to GitHub

Render (step 3) deploys from a GitHub repository. If you don't already
have a place for this code:

1. Go to [github.com/new](https://github.com/new), create a new
   **private** repository (e.g. `mg-service-approval`), and don't
   initialize it with a README (this project already has one).
2. In a terminal, inside the extracted project folder (the one with
   `package.json` in it — already a git repository with one commit):
   ```bash
   git remote add origin https://github.com/<your-username>/mg-service-approval.git
   git branch -M main
   git push -u origin main
   ```
   GitHub will prompt you to sign in the first time.

## Step 3 — Deploy on Render

1. Go to [render.com](https://render.com) and sign in (or create a free
   account) — GitHub sign-in is the quickest, since you'll need to connect
   your GitHub account either way.
2. Click **New +** → **Blueprint**, and select the repository you pushed
   in Step 2. Render will read this project's `render.yaml` file and
   propose one web service (`mg-service-approval`) on the **free** plan,
   with `NODE_ENV` and a random `JWT_SECRET` already filled in for you.
3. Before clicking **Apply**, add the one variable Render can't fill in
   for you: `DATABASE_URL` — paste the Supabase connection string from
   Step 1.
4. Click **Apply** / **Deploy**. The first deploy takes a few minutes
   (`npm install`, then the server starts). Watch the logs — you should
   see `[mg-approval] Using Postgres-backed storage.` near the top, which
   confirms it found your database.
5. Once it's live, Render gives you a URL like
   `https://mg-service-approval.onrender.com` — that's the app, live on
   the internet.

**Free tier note**: Render's free web services "sleep" after 15 minutes
with no traffic, and take about a minute to wake back up on the next
request. That's fine for how a small dealership team will actually use
this — occasional idle periods just mean the first click of the day is a
bit slower.

## Step 4 — Set real passwords

Every demo account still has the password `password123` until changed.
Before handing this to your team:

1. Log in as each account you plan to actually use (or create new ones —
   as the Aftersales Admin, under account management).
2. Click **Change Password** in the header and set a real password for
   each one.

Nobody needs to remember `password123` going forward — that's exactly
what the Change Password button (added earlier) is for.

## Updating the app later

Any time you want to ship a change: edit the code, commit, and
`git push` — Render redeploys automatically on every push to `main`.

## If something doesn't come up

- **Build fails on Render**: check the build logs (Render's dashboard →
  your service → Logs). The most common cause is a missing environment
  variable — double check `DATABASE_URL` is set exactly as copied from
  Supabase (including the password, with no `[YOUR-PASSWORD]` placeholder
  left in it).
- **App loads but login fails for everyone, including demo accounts**:
  this usually means it's running against a *fresh* empty database (first
  deploy, or a new Supabase project) — that's expected, and it seeds itself
  with the demo accounts automatically the first time it starts. If it
  still fails, check the Render logs for a database connection error.
- **"relation does not exist" or similar Postgres errors**: the app
  creates its own table automatically on first boot — if you see this, it
  usually means `DATABASE_URL` is pointing at the wrong project/database.
