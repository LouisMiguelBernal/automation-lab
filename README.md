# Automation Lab

Two tracks that meet in the middle: run **n8n** locally and build workflows in it,
and build a **Stripe** Checkout + webhook integration that feeds those workflows.

```
Customer pays  →  Stripe  →  webhook (signature-verified)  →  n8n workflow
                                  stripe-lab/src/server.js      Sheets / email / Slack / …
```

---

## Track 1 — n8n

```bash
cd n8n
docker compose up -d
```

Open http://localhost:5678 and create the owner account (local only, test data).

Stop / logs / reset:

```bash
docker compose down          # stop, keep data
docker compose logs -f n8n   # follow logs
docker compose down -v       # wipe the database and start clean
```

### The mental model

A workflow is **one trigger + a chain of nodes**. Every node receives an array of
items and returns an array of items; the next node runs once per item. Almost all
n8n confusion comes from forgetting that data is a *list*, not a single object.

| Concept | What it is |
|---|---|
| Trigger | Starts the run: Manual, Schedule (cron), Webhook, or an app event |
| Node | One step — HTTP Request, Set, IF, Code, Gmail, Postgres… |
| Expression | `{{ $json.email }}` — pulls from the current item |
| `$('Node Name')` | Reach back to an earlier node's output |
| Credential | Encrypted secret, stored once, reused across workflows |
| Execution | One run, with the data at every step — your debugger |

### Build these four, in order

1. **Schedule → HTTP Request → Set.** Hit a public API every 5 minutes, keep three
   fields. Teaches expressions and the item list.
2. **Webhook → IF → two branches.** Grab the test URL, `curl` it, branch on a field.
   Teaches the production-vs-test URL distinction: a webhook only listens on its
   test URL while the editor is open, and on its production URL once *activated*.
3. **Add a Code node.** `return items.map(i => ({ json: {...i.json, ok: true} }))`.
   Teaches the item contract concretely.
4. **Wire in Stripe** (below).

### Things that will bite you

- **`N8N_ENCRYPTION_KEY`** is set in `docker-compose.yml`. Change it after saving
  credentials and they all become unreadable. Set it once, keep it.
- **Localhost inside the container is the container**, not your PC. To call
  `stripe-lab` from an n8n node use `http://host.docker.internal:4242`.
- **Errors stop the branch.** Use the node's *Settings → On Error* (continue, or
  route to an error output) plus retry-on-fail, rather than hoping.
- **Activate** a workflow or its production trigger never fires.

---

## Track 2 — Stripe

```bash
cd stripe-lab
cp .env.example .env      # already done — fill in real test keys
npm run dev
```

Get test keys at https://dashboard.stripe.com/test/apikeys (`sk_test_…`).
Then install the CLI and forward events to your machine:

```bash
stripe login
stripe listen --forward-to localhost:4242/webhook
```

`stripe listen` prints a `whsec_…` — put that in `.env` as
`STRIPE_WEBHOOK_SECRET`. It is **not** the same secret as the one shown on a
dashboard endpoint; mixing them up is the usual cause of 400s.

Then open http://localhost:4242, pay with `4242 4242 4242 4242`, any future
expiry, any CVC. Or fire an event without paying:

```bash
stripe trigger checkout.session.completed
```

### The four rules that matter

1. **Never trust the browser redirect.** `success_url` is where the customer
   lands, not proof of payment — they can close the tab, or type the URL. The
   webhook is the source of truth.
2. **Verify the signature against the raw bytes.** The webhook route uses
   `express.raw` and is mounted *above* `express.json()`. Parse first and every
   signature fails.
3. **Be idempotent.** Stripe retries for up to 3 days, so the same `event.id`
   will arrive twice. Record handled ids (a DB unique constraint in production)
   or you will ship the order twice.
4. **Ack in under 20 seconds.** Respond `200` immediately, then do the work —
   or hand it to n8n.

### Amounts

Integers in the smallest currency unit. `$25.00` is `2500`. Never floats.

---

## Track 3 — join them

1. In n8n: new workflow → **Webhook** node, method `POST`, path `stripe`. Copy
   the **test** URL.
2. In `stripe-lab/.env` set:
   `N8N_WEBHOOK_URL=http://host.docker.internal:5678/webhook-test/stripe`
   (swap `webhook-test` → `webhook` once the workflow is activated).
3. Restart `npm run dev`, run `stripe trigger checkout.session.completed`.
4. n8n receives the **verified** event. Add an IF node on
   `{{ $json.type === 'checkout.session.completed' }}` and do something on the
   true branch.

The split is deliberate: signature verification and the fast `200` stay in code,
because they must be exactly right. Everything after — notify, record, fulfil —
lives in the workflow, where you can change it without a deploy.

---

## Layout

```
n8n/docker-compose.yml   n8n + persistent volume
n8n/files/               shared folder, mounted at /files in the container
stripe-lab/src/server.js Checkout session + verified webhook + n8n forward
stripe-lab/.env          your test keys (gitignored)
```
