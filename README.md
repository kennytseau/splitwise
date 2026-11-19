# Evenly

A small expense splitter for a household or a trip. Log what each person pays,
and it works out who owes whom and the fewest payments that clear everyone.

Two files do the work: one static page and one Cloudflare Function. No build
step, no framework, no npm install.

![none](public/icon.svg)

## What it does

- **Groups** of people who share costs, each with its own currency. Defaults to
  AUD; 22 currencies are selectable per group, including the zero-decimal ones
  (JPY, KRW, VND, IDR), which are rounded to whole units.
- **Four ways to split** an expense: evenly, exact amounts, percentages, or
  shares. Percentages and shares must balance before the expense can be saved.
- **Several payers** on one expense, when two people cover one bill.
- **Balances** per person, and a settle-up view that reduces the web of debts to
  the fewest transfers — three people with tangled balances usually collapse to
  two payments.
- **Recorded payments** that square people up without changing what anything cost.
- **Activity feed**, **CSV export**, and a per-device "you are ___" picker that
  decides whose side the "you owe / you lent" figures are shown from.

All money is handled as integer minor units, and splits are apportioned by the
largest-remainder method, so the parts always add back to the exact total.
$100 across three people comes out 33.34 / 33.33 / 33.33, never 99.99.

## Running it

Open `public/index.html` in a browser. It works immediately, storing everything
in that browser's local storage. That is enough for one person on one device.

To share a ledger with other people, deploy it — the sharing feature needs the
Function and the database.

## Deploying to Cloudflare

Everything below is done in the Cloudflare dashboard. No local tooling needed.

**1. Create the database**

Dashboard → **Storage & Databases → D1** → **Create database**, name it `evenly`.
Open it, go to the console tab, paste the contents of [`schema.sql`](schema.sql)
and run it.

**2. Create the Pages project**

Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**,
and pick this repository. Build settings:

| Setting                | Value    |
| ---------------------- | -------- |
| Framework preset       | None     |
| Build command          | *(empty)* |
| Build output directory | `public` |

Deploy. The first build publishes the page but sharing will not work yet.

**3. Bind the database**

In the project's **Settings → Bindings** (older dashboards: *Functions → D1
database bindings*), add a **D1 database binding**:

| Variable name | Database |
| ------------- | -------- |
| `DB`          | `evenly` |

Add it for both Production and Preview if you use preview deployments, then
redeploy (Deployments → ⋯ → Retry deployment) so the binding takes effect.

**4. Share it**

Open your `*.pages.dev` URL, create a group, then click the status chip in the
top bar → **Create a shared space**. Send the link it gives you to whoever you
split with. Opening that link on any device — phone, laptop, anyone's browser —
joins the same ledger. No account, no sign-up.

On a phone, "Add to Home Screen" installs it as a standalone app.

### Deploying with the CLI instead

See [`wrangler.example.toml`](wrangler.example.toml) if you would rather use
`wrangler` than the dashboard.

## How sharing works

A shared space is a row in the `ledgers` table, plus a 256-bit secret that is
generated in the browser and put in the share link's fragment — the part after
`#`, which browsers never send to a server.

Two keys are derived from that secret with HKDF:

| Key | Who sees it | Used for |
| --- | ----------- | -------- |
| auth key | sent to the server, stored only as a SHA-256 | proving you may read and write the ledger |
| encryption key | never leaves the device | AES-GCM on every record body |

Because the two are derived separately, holding the auth key tells you nothing
about the encryption key. **The server stores ciphertext it cannot read**, and
neither can anyone with access to the Cloudflare account or the D1 database.

What is still visible to the server: how many records a ledger holds, whether
each is a group, an expense or a settlement, and when each last changed. The
contents — who, what, how much — are not.

The link is the credential and the key at once. **Anyone who has it can read and
edit that ledger**, so send it somewhere private. There is no reset and no
recovery: if the link is lost, the data is unreadable for good, and if it leaks,
the only remedy is a new space. Export a CSV now and then if that matters.

Each device keeps a full local copy and syncs through a single endpoint, so the
app keeps working with no connection and catches up when one returns. Conflicts
resolve last-writer-wins per record, by the editing device's clock. For a
household this is the right trade: two people rarely edit the same expense in
the same minute, and the alternative costs far more complexity than it saves.

## API

| Route             | Body                      | Returns                       |
| ----------------- | ------------------------- | ----------------------------- |
| `POST /api/ledger`| `{ keyHash }`             | `{ id }`                      |
| `POST /api/sync`  | `{ records[], since }`    | `{ records[], cursor, more }` |

`/api/sync` requires `x-ledger-id` and `x-ledger-key` headers. It applies the
pushed records, then returns everything changed since `cursor`, paged.

## Layout

```
public/index.html   the whole app — UI, split maths, sync client
public/icon.svg     app icon
public/manifest.webmanifest
functions/api/[[route]].js   sync API (Cloudflare Pages Function)
schema.sql          D1 tables
```

## Costs

Comfortably inside Cloudflare's free tier for household use: D1 allows 5 GB of
storage and 5 million row reads a day, and Pages Functions 100,000 requests a
day. A ledger with a few thousand expenses is well under a megabyte.

## Licence

MIT — see [LICENSE](LICENSE).
