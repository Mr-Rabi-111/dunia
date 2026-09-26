# Dunia — business model, pricing and growth

This is the business plan built into the product: what's free, what's paid, why each price and
screen is designed the way it is, how people are brought back every day, and the numbers to watch.
Everything described here is already implemented; file and setting names are given so you can change it.

> **The one rule:** random video chat lives or dies on trust. Every tactic below makes the product
> more valuable or easier to buy. None of them trick people. Tricks raise revenue for a month, then
> refunds, 1-star reviews, Play Store strikes and regulators take it back.

---

## 1. What is free and what is paid

| Free, forever | Premium |
|---|---|
| Unlimited video chats with anyone | **Men only / Women only filter** (the thing people will pay for) |
| Country filter, language filter, interests | Matched a little faster (+2 in the match score, see [MATCHING.md](MATCHING.md)) |
| Chat, translation, reactions | Gold badge next to your name |
| Report, block, all safety tools | |

**Why the gender filter:** on every random-chat platform it is the single most requested filter and
the one with a clear willingness to pay. Everything else stays free so that the free product is
genuinely good. A good free product is what fills the pool of people, and the pool of people is
what Premium users are paying to reach.

The filter stays **mutual** even for Premium: a Premium user filtering for women only meets women
whose own filters accept them. Paying never overrides anyone else's choice.

## 2. Price ladder

| Pass | UPI price | Per day | vs. the pass before | Google Play (Play Store app) |
|---|---|---|---|---|
| 15 minutes | **₹1** | – | – | not sold (below Play's ₹10 minimum) |
| 1 hour | ₹3 | – | save 25% | not sold (below Play's ₹10 minimum) |
| 1 day | ₹19 | ₹19 | save 74% | `dunia_pass_day1` |
| 1 week *(Popular)* | ₹69 | ₹9.86 | save 48% | `dunia_pass_week1` |
| 1 month *(Best value)* | ₹149 | ₹4.97 | save 50% | `dunia_pass_month1` |

Defined once in `shared/data.js` (`PLANS`). A unit test (`test/premium.test.js`) enforces that the
price per hour **always falls** as passes get longer, so every "save" label is true.

**Why these prices**

- **₹1 is a foot in the door.** The first payment is the hardest one. At ₹1 there's nothing to think
  about, and once someone has paid with UPI once, paying ₹19 or ₹69 is a small step. The ₹1 pass
  mostly exists to be a person's *first* purchase, not to make money.
- **Anchoring and a decoy.** The month pass (₹149) makes the week (₹69) look reasonable, and the day
  (₹19) makes the week look like a bargain (7 days for the price of 3.6). The week is pre-selected
  and marked *Popular*; the month is marked *Best value*.
- **Per-day framing.** "₹4.97 per day" is shown under the monthly price, which is honest and easier
  to judge than ₹149.
- **Passes, not subscriptions.** Nothing renews on its own. That means no forgotten charges, no
  cancellation complaints, and it is the model Indian users already know from mobile data packs.
  Passes stack: buying another adds time.
- **Change prices** in `shared/data.js` (UPI) and in Play Console → Monetize → One-time products (Play).
  Keep the Play product IDs the same.

## 3. The purchase flow and the psychology behind each step

| Moment | What the user sees | Principle | Where |
|---|---|---|---|
| Taps **Men** or **Women** | Paywall opens *right there*, the filter is not applied yet | **Contextual paywall**: ask when the value is obvious, not on launch | `public/js/app.js` gender filter handler |
| First time | "Try it free for 10 minutes" above the plans | **Free trial / endowment**: once people have had the filter, they value it more | `reward:trial`, `PREMIUM_TRIAL_MIN` |
| Plans | 5 cards, week pre-selected, per-day prices, save %, badges | **Anchoring, decoy, framing** | `renderPlans()` in `public/js/premium.js` |
| Pays | Phone: "Open my UPI app" (any app). Desktop: QR code to scan | **Remove friction**: one tap, any UPI app | `startUpi()` |
| After paying | Premium starts at once, and **the filter they wanted is switched on for them** | **Instant gratification, completion** | `setStatus()` → `onPremiumChange()` |
| 2 minutes before it ends | Toast: "Premium ends in 2 minutes. [Extend]" | **Loss aversion, honestly used**: a real deadline, shown once | `tick()` in `premium.js` |
| It ends | Filter goes back to Anyone, a short message. Chats continue | **No punishment**: the free product still works | `premium:expired` |
| During calls | Premium users show a small gold badge to partners | **Social proof / visibility** | `peer.premium` |

**Restore a purchase** (UTR or Google order ID) is always one tap away, so a new phone never means
paying twice.

## 4. Coming back every day (retention)

| Feature | How it works | Why it's healthy |
|---|---|---|
| **Daily bonus** | Have one real chat (30 s or more) and a daily bonus of free Premium minutes unlocks. Streak: 5, 5, 10, 10, 15, 15, 30 min, then it repeats. Resets at midnight IST | Rewards *using* Dunia, not just opening it. Missing a day restarts the streak; there's no "pay to save your streak" |
| **Invite friends** | Personal link `https://your-domain/?ref=CODE`. When the friend's first real chat (60 s or more) ends, **both** get 30 Premium minutes | Two-sided rewards convert far better than one-sided ones. The WhatsApp share sheet is the default on phones |
| **Your world** | Every new country you actually talk to is added to your collection, with a "New country: Brazil! That's 12 so far." toast | Collection / goal-gradient. Fits the product's promise ("say hi to the world") and costs nothing |
| **Perks strip** | Three tiles in the lobby: Daily bonus (red dot when ready), Invite, Your world | Makes rewards visible without pop-ups |

Anti-abuse (server-side, `server/premium.js`): trial once per device and at most 3 per IP per day;
referrals only for brand-new devices, never from the inviter's own network, paid once; daily bonus
needs a real call recorded by the server, not by the client.

## 5. What Dunia deliberately does not do

India's **Guidelines for Prevention and Regulation of Dark Patterns, 2023** (Central Consumer
Protection Authority) list 13 banned practices. Google Play's policies ban deceptive monetisation
too. Dunia avoids all of them:

- **No false urgency.** No fake countdowns, no "only 2 left", no "offer ends tonight".
- **No subscription trap.** Nothing auto-renews, so there's nothing to cancel.
- **No confirm-shaming.** Closing the paywall is a plain ✕, with no guilt-trip copy.
- **No drip pricing or basket sneaking.** The price on the button is what you pay.
- **No nagging.** The paywall only opens when *you* tap a Premium filter or the Premium chip.
- **No fake users or fake activity.** "Online" counts are real; there are no bots.
- **No bait and switch.** Free features stay free.
- **No pay-to-win safety.** Reporting, blocking and moderation are identical for everyone.

## 6. Numbers to watch (admin console → Payments, `/metrics`)

| Stage | Metric | Healthy starting target* |
|---|---|---|
| Acquisition | New devices per day; invites sent / accepted | Referral K-factor 0.2 or more |
| Activation | % of new devices with a call of 60 s or more on day 1 | 60% or more |
| Paywall reach | % of daily users who open the paywall | 15–25% |
| Trial | % of paywall viewers who start the free trial | 40% or more |
| Conversion | % of daily users who buy any pass | 2–5% |
| Revenue | ARPDAU (revenue ÷ daily users) | ₹0.5–₹2 |
| Retention | Day-1 / Day-7 / Day-30 return rate | 30% / 12% / 5% |
| Trust | Refund requests, rejected UTRs, reports per 1,000 calls | falling over time |

*Targets are typical ranges for consumer apps in India, not promises. Measure your own baseline in
the first two weeks and improve from there.

## 7. Unit economics (illustrative)

Dunia's calls are peer-to-peer, so the servers carry signalling (tiny) and TURN relay traffic for
the roughly 15% of calls that can't connect directly.

| Assumption | Value |
|---|---|
| Video bitrate per direction | ~0.6 Mbit/s |
| Share of calls relayed through TURN | ~15% |
| TURN traffic per relayed call-minute | ~18 MB (in + out, both people) |
| Average TURN traffic per call-minute | ~2.7 MB |

| Hosting | Bandwidth price | Cost per 1 million call-minutes |
|---|---|---|
| Hetzner / OVH dedicated (20 TB+ included) | ~€1/TB over quota | about ₹0–₹250 |
| AWS / GCP (egress about $0.09/GB) | $90/TB | about ₹20,000 |

**Takeaway:** host TURN on a provider with included bandwidth (see [DEPLOYMENT.md](DEPLOYMENT.md)).
With 10,000 daily users, 3% buying a ₹19 day pass is about ₹5,700/day before fees, while
infrastructure on Hetzner stays in the low thousands of rupees per month.

## 8. Getting paid: UPI today, a gateway tomorrow

**Today (built in):** payments go to the UPI ID `abirkumar111@ybl` (`UPI_VPA`). The user enters the
12-digit UTR, and Premium starts (in `provisional` mode, up to 60 minutes immediately). You approve
payments in `/admin` → Payments, or paste your bank / PhonePe Business statement into "Confirm from
bank statement" to approve every matching UTR at once. Fake UTRs are rejected, the time is taken
back, and three rejections block payments from that device.

**Limits of a personal UPI ID** (read this before scaling):

- There's no automatic payment confirmation, so someone has to approve or reconcile.
- Banks and UPI apps may limit or flag a personal account that receives many small payments. Some
  apps (notably Google Pay) block payments started from a link to a personal UPI ID; scanning the
  QR code works more reliably, which is why the QR is always shown.
- For a business you'll need a **merchant UPI ID** (PhonePe Business, Paytm for Business, BharatPe)
  or a **payment gateway** (Razorpay, Cashfree, PayU). These confirm payments automatically by
  webhook. To switch, add a webhook route that calls `premium.approve(orderId)`; the rest of the
  flow (orders, passes, restore, admin) stays the same.

**Tax:** once turnover crosses the GST threshold, register for GST; online digital services are
taxed at 18%. Keep payment records (the admin console and `data/premium.json` have them). Ask a CA.

**Google Play:** the Play Store build must sell passes through Google Play Billing (Google takes a
service fee, currently 15% on a developer's first $1M a year for most apps; check Play Console for current rates). See [PLAY-STORE.md](PLAY-STORE.md).

## 9. Growth plan

1. **Launch in India first.** Hindi, Bengali, Tamil and Urdu interfaces are built in, UPI works
   everywhere, and ₹1 lowers the barrier to zero. Target college towns and metro evenings (8 pm–1 am IST).
2. **WhatsApp-first referrals.** Invite links open WhatsApp on phones; the reward is shared by both.
3. **Short-video content.** Reels / Shorts of wholesome cross-country moments ("I talked to someone in
   Brazil for the first time"), with consent. The "Your world" collection makes shareable screenshots.
4. **Language communities.** The language filter plus the "Language exchange" interest is a free,
   low-risk entry point for learners (English practice is a big one in India).
5. **Then expand** to Indonesia, the Philippines, Türkiye, Brazil and the Middle East, which are already
   localised. Add Play Billing or a local wallet per market, since UPI is India-only.
6. **Later revenue lines** (not built): gift reactions bought with coins, a verified-profile badge,
   an ad-free-forever lifetime pass. Only add ads if you must, and never inside a call.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Moderation failure (nudity, minors) | 18+ gate, report with snapshot, auto-restriction, admin console. Budget for human moderators as you grow; consider an automated nudity classifier on report snapshots |
| Payment fraud (fake UTRs) | Provisional cap, reconciliation, rejection → time removed → block after 3 |
| Store rejection | Follow [PLAY-STORE.md](PLAY-STORE.md) exactly; ship the website and the direct APK in parallel |
| Personal UPI ID limits | Move to a merchant ID / gateway before scaling (section 8) |
| Gender imbalance (many men, fewer women) | The mutual filter protects women's choices; invite campaigns aimed at women; strong safety tools. Watch the women:men ratio as a key metric |
