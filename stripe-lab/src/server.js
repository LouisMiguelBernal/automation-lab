import express from 'express';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:4242';

/* ---------------------------------------------------------------------------
 * 1. WEBHOOK  —  must come BEFORE express.json().
 *
 * Stripe signs the exact bytes it sent. If a JSON parser touches the body
 * first, re-serializing changes those bytes and every signature check fails.
 * This is the #1 thing people get wrong.
 * ------------------------------------------------------------------------- */

// Stripe retries for up to 3 days, so the same event id can arrive twice.
// Real apps store handled ids in a DB with a unique constraint; a Set is
// enough to see the mechanic.
const handledEvents = new Set();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,                              // raw Buffer, untouched
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // 400 tells Stripe "bad signature, don't bother retrying"
    console.error('signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Ack fast. Stripe times out at 20s and will retry if you're slow, so do
  // the real work after responding (or push it onto a queue / n8n).
  res.json({ received: true });

  if (handledEvents.has(event.id)) {
    console.log(`duplicate ${event.type} (${event.id}) — skipped`);
    return;
  }
  handledEvents.add(event.id);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log(`PAID  ${session.amount_total / 100} ${session.currency.toUpperCase()}` +
                  `  ${session.customer_details?.email ?? 'no email'}`);
      // This is where you'd grant access, create the order, send the receipt.
      break;
    }
    case 'payment_intent.payment_failed':
      console.log(`FAILED  ${event.data.object.last_payment_error?.message}`);
      break;
    default:
      console.log(`unhandled: ${event.type}`);
  }

  await forwardToN8n(event);
});

// Hand the verified event to n8n so the business logic lives in a workflow
// instead of in this file.
async function forwardToN8n(event) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: event.id, type: event.type, data: event.data.object }),
    });
  } catch (err) {
    console.error('n8n forward failed:', err.message);
  }
}

/* ---------------------------------------------------------------------------
 * 2. Everything below may parse JSON normally.
 * ------------------------------------------------------------------------- */
app.use(express.json());

// Creates a one-off Checkout Session and returns its hosted URL.
// price_data builds the product inline — fine for testing. In production you
// create Products/Prices once in the dashboard and pass `price: 'price_...'`.
app.post('/api/checkout', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: 2500,                       // amounts are in cents
          product_data: { name: 'Automation Lab — test product' },
        },
      }],
      success_url: `${PUBLIC_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/success', async (req, res) => {
  const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
  res.send(`<h1>Paid</h1><pre>${session.payment_status} — ${session.amount_total / 100} ${session.currency}</pre>
            <a href="/">back</a>`);
});

app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8">
    <title>Stripe Lab</title>
    <body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
      <h1>Stripe Lab</h1>
      <p>Test card: <code>4242 4242 4242 4242</code>, any future expiry, any CVC.</p>
      <button id="buy" style="font-size:1rem;padding:.6rem 1.2rem">Buy — $25.00</button>
      <script>
        document.getElementById('buy').onclick = async () => {
          const r = await fetch('/api/checkout', { method: 'POST' });
          const { url, error } = await r.json();
          if (url) location.href = url; else alert(error);
        };
      </script>
    </body>`);
});

const port = process.env.PORT ?? 4242;
app.listen(port, () => console.log(`stripe-lab → http://localhost:${port}`));
