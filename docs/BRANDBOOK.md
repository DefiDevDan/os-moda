# osModa Brand Book

*v1 · 2026-05-04 · the durable reference for everything we say + show*

---

## 1. The one-line essence

**osModa is your AI workforce in a box. Hire workers for sales, support, content, dev, ops, and research. They pick up the work and don't put it down.**

Not a chatbot. Not a SaaS subscription. Not infrastructure. A *workforce*.

---

## 2. The bathhouse metaphor (the whole brand)

osModa is Yubaba's bathhouse. A magical workshop where many spirits with
different specialties take requests, sign contracts, do work, get paid,
and never close. You sign one contract and become the proprietor — the
boss-by-proxy. The work happens whether you're awake or not. Soot
sprites scuttle in the boiler room (background routines). Each spirit
has a craft. **You don't manage them. You manage the bathhouse.**

Every metaphor has a one-to-one mapping:

| Spirited Away | osModa |
|---|---|
| Yubaba's bathhouse | Your osModa server |
| The contract Chihiro signs | Your gateway token |
| Yubaba | You — the proprietor |
| Haku | Your lead agent (Opus) |
| Each spirit | A specialized AI worker (sales, support, …) |
| Soot sprites in the boiler room | Background routines (heartbeats, log scans, daily reports) |
| The bathhouse never closes | 24/7 workforce |
| Spirits hand off coupons | Tasks moving between agents |
| Yubaba's stamp of approval | Your nod on risky actions |
| Chihiro keeping her real name | You can take everything with you. Open source. Your data. |

Use this metaphor in copy *sparingly* and *concretely* — never preachy,
never abstract. Lean on it for hero illustrations and section visuals.
The worst possible copy: "Welcome to the bathhouse of intelligence."
The best: "Tofu-bot replied to 12 customer emails this morning."

---

## 3. The customer (3 archetypes — write to these humans)

### A. The drowning founder
- Solo or 2-person team. 60+ hours/week. Living in 50 SaaS tabs.
- **Pain**: every morning is the same triage. Inbox, support, social, invoices, follow-ups. Real growth work never happens.
- **Hope**: hire someone. Salaries are $80k+; junior VAs require management.
- **Our promise**: $34/mo for a Pro tier. AI workers pick up the busywork and don't put it down. Your Tuesday gets quieter.
- **Emotional payoff**: relief. Time back. Dignity restored.

### B. The pre-launch dreamer
- Has an idea. Has had it for six months. Notion doc, no website, no entity, no first customer.
- **Pain**: doesn't know how to register a company, find a domain, build a site, write the launch copy, set up payments.
- **Hope**: a cofounder. Cofounders are rare and expensive.
- **Our promise**: tell us the idea. Your AI team picks names, registers domains, builds the site, writes the launch copy, sets up Stripe, finds first customers.
- **Emotional payoff**: courage. The thing finally moves.

### C. The agency operator
- Runs a service business across 8 SaaS apps. Stripe + Notion + Slack + Gmail + Calendly + Webflow + Linear + a CRM.
- **Pain**: switching contexts. Repetitive ops. Manual reporting.
- **Hope**: someone (or something) that learns the workflows and keeps doing them.
- **Our promise**: plug your tools in. Hand off the busywork. The AI workers learn how you do things and keep doing them.
- **Emotional payoff**: leverage. The same person can run a bigger business.

Write copy to ONE of these three at a time. Never compose a sentence
that tries to address all three; it will become abstract sludge.

---

## 4. Voice & tone

**Calm. Confident. Warm. A little wry.** Like a kind sensei explaining
how the workshop works. Never breathless. Never corporate. Never cute-stupid.

**Do**:
- Verbs. Specifics. Names. Times.
- One concrete number per claim ("Replied to 12 tickets", not "high productivity").
- Short sentences. Two clauses, max.
- The reader's life: their Tuesday, their inbox, their week back.

**Don't**:
- Buzzwords ("intelligent", "next-generation", "revolutionary", "platform", "ecosystem", "cutting-edge").
- Banned tech vocabulary (see §6).
- Fake urgency ("Limited time!").
- Em-dash overdose. (One per paragraph max, two only when earned.)
- The phrase "AI-powered". Of course it's AI. Don't insult the reader.

---

## 5. Headline patterns that work

Use these structures. Fill them in.

| Pattern | Example | Why it works |
|---|---|---|
| **Verb + outcome** | "Hire your AI workforce." | Action, not feature. |
| **A vs. B** | "Stop renting servers. Start hiring AI workers." | Contrast names the old way. |
| **Time relief** | "Get your Tuesday back." | Names the felt cost. |
| **Possessive** | "Your studio. Your team. Your terms." | Asserts ownership. |
| **The one sentence** | "A whole company in a server. Yours." | Simple, complete picture. |
| **Permission** | "You're still the boss." | Disarms the control fear. |
| **Concrete day** | "By 9am, support is replied to. By noon, the post is live." | Shows, doesn't tell. |
| **Choice** | "Build something new. Or hand off what you have." | Both archetypes A+B+C welcome. |

The hero must hit one of these patterns. No others.

---

## 6. Banned vocabulary — never appears on the marketing site

If you find yourself typing any of these on the marketing surface,
delete the sentence and start over.

| Don't say | Why | Say instead |
|---|---|---|
| daemon | Means nothing to normies | worker, helper |
| MCP / tools / runtime | Tech jargon | what they do, the work |
| infrastructure | Sounds like an AWS bill | the studio, the workshop, your server |
| agent (overused) | Drained of meaning | worker, spirit, helper, teammate |
| platform | Empty word | studio, workshop |
| ecosystem | Empty word | toolkit |
| AI-powered | Insulting | (cut) |
| 92 tools / 20 skills / 13 daemons | Counts mean nothing to outcomes | (cut) |
| Rust / NixOS / TypeScript | Implementation details | (cut from marketing; OK in /docs and /skill) |
| post-quantum / encryption | Tech-flex | "Your data stays yours" |
| autonomous | Eerie to normies | works on its own / keeps going |
| enterprise | Cringe | (cut) |

The `/docs` and `/skill` and `/api/v1/docs` pages can be technical. The
landing page, dashboard onboarding, pricing — all normie-first.

---

## 7. Visual identity

### 7.1 Palette — "ink on paper, watercolor sky"

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#FAF6EE` | primary background — warm cream, like aged sketchbook |
| `--paper-2` | `#F2EDE0` | card background, subtle separation |
| `--ink` | `#1F1B16` | primary text — warm dark brown, never pure black |
| `--ink-2` | `#3C4A66` | secondary text — twilight |
| `--ink-3` | `#7A7166` | tertiary text — soft sepia |
| `--sky` | `#A8C5E2` | sky behind clouds, info badges |
| `--camellia` | `#E8978C` | primary accent — coral-pink. CTAs. |
| `--camellia-deep` | `#C56F62` | hover/pressed for camellia |
| `--mint` | `#9DC7AC` | success states, "task done" |
| `--saffron` | `#F2C078` | highlights, lantern glow, warnings |
| `--mist` | `#EFEAE0` | subtle dividers |
| `--haku` | `#A8C5E2` | dragon-pale-blue — used for headers, links |

The palette is taken from a Spirited Away mid-morning frame: cream
paper, warm ink lines, dusty pastel sky, camellia accents, soft mint for
the spirit-river, saffron for lantern-light. **Never use pure black,
never use pure white.** The eye reads "drawn", not "rendered".

### 7.2 Typography

- **Display**: **Fraunces** (Google Fonts) — warm serif with display character. Ranges from elegant to friendly via optical size. Headlines, big numbers.
- **Body**: **Geist** or **Inter** — clean, neutral, shadcn-native. All UI copy.
- **Mono**: **Geist Mono** or **JetBrains Mono** — for micro-labels (timestamps, costs).

Type rules:
- Headlines max 4 words per line. Hero hero hero.
- Body copy max 70 chars per line. Generous leading (1.5–1.6).
- Never set body smaller than 16px on desktop, 15px on mobile.
- Letter-spacing: -0.01em on display, 0 on body, +0.04em on tiny labels.

### 7.3 Illustration system — "ink-pixel"

Three layers, every illustration:

1. **Pencil ink**: SVG paths, `stroke-linecap=round`, slightly wobbled (use `<filter>` `<feTurbulence>` for hand-drawn jitter). Color is `--ink`, never `#000`. Stroke widths: 1.25 / 2 / 3 px depending on hierarchy.
2. **Watercolor wash**: low-opacity pastel blobs underneath the ink lines. Soft radial gradients, `mix-blend-mode: multiply` on overlap. Edges feathered.
3. **Pixel sprites**: tiny 16×16 mascots in window frames or task badges. Exact pixel grids — `image-rendering: pixelated`. These are the "spirits".

Compose from this kit:
- Floating clouds (pencil + watercolor)
- A sectioned "workshop" / "atelier" — cross-section view, multi-room
- Pixel spirits poking out of windows
- Floating task notification cards
- Soft sun-glow in upper corners

Never use:
- Stock photos
- 3D renders (the prior `Spirit Orb` Three.js thing — retire it)
- Glassmorphism / frosted glass
- Neon glow / dark grids / cyberpunk anything

### 7.4 Mascots — the "moda spirits"

Each role has its own pixel-spirit. 16×16 pixel grid, two-frame idle
animation. Same body shape, different color + accessory.

| Role | Color | Accessory | One-liner |
|---|---|---|---|
| **Sales spirit** | camellia | tiny envelope | "Finds people. Sends notes. Follows up." |
| **Support spirit** | mint | speech bubble | "Replies to customers. Escalates the hard ones." |
| **Content spirit** | saffron | scroll/quill | "Writes posts. Schedules. Sends." |
| **Dev spirit** | haku-blue | wrench | "Builds. Deploys. Fixes." |
| **Ops spirit** | twilight | abacus/coin | "Tracks money. Files reports." |
| **Research spirit** | sky | magnifier | "Reads. Summarizes. Briefs you." |

The spirits have a name family: **Tofu** (sales), **Sumi** (support),
**Iro** (content), **Haku** (dev — yes, that one), **Kane** (ops),
**Kiri** (research). First letter of each is the mnemonic if anyone
asks: T-S-I-H-K-K → no acronym, just six little workers. Don't mention
the names in headline copy; use them in product UI ("Tofu sent your
outreach batch").

---

## 8. Section system (re-usable patterns)

### 8.1 Hero
- Left: headline (Fraunces, 60–80px) + subhead (Geist, 22–24px) + 2 CTAs (camellia primary + ghost secondary).
- Right: hero scene (the workshop on a cloud) with floating task cards.
- Top: thin nav bar.

### 8.2 Three pillars
Three cards, equal width. Each: small mascot (16×16 zoomed), 3-word
headline, 1-sentence body. No more.

### 8.3 Use-case grid (6 tiles)
Two rows of three. Each tile: mascot + role name + one-line of work +
one *concrete* sample task ("Sent 47 outreach emails today").

### 8.4 Two-path section
"Build something new" vs "Run something existing" — two columns, equal
weight. Each: short headline, 3-bullet list of what the spirits do.

### 8.5 Typical day
Vertical timeline of a day in the bathhouse: 7am, 9am, 11am, 2pm, 4pm,
11pm. Each row: time + mascot + one-line task. Pixel-art frame
illustrations between rows.

### 8.6 Pricing (4 cards)
**No CPU/RAM/disk specs.** Each: tier name, price, **team size phrasing**
("1 worker", "Up to 4 workers"), one sample use case, CTA.

### 8.7 Control assurance
Three small cards: "Big actions wait for your nod" / "Costs are capped" /
"Bad changes roll back automatically."

### 8.8 Open + yours
One paragraph, one hero number ("Every line of the engine is open
source"), one screenshot of the GitHub repo. No "open source" badges.

### 8.9 Final CTA
Repeats hero verb. Same button. One line.

---

## 9. Copy library (lift directly into the page)

### 9.1 Hero headline candidates
- "Hire your AI workforce."
- "Build a company with AI workers, from A to Z."
- "A whole company. In one server. Yours."
- "Stop renting servers. Start hiring AI workers."
- "Your studio. Your team. They never close."

### 9.2 Hero sub-line candidates
- "Sales, support, content, dev, ops, research — they pick up the work and don't put it down."
- "Build something new. Or hand off the running of what you have. Either way, your week opens up."
- "From idea to revenue. Or from inbox to free Tuesday. Both, on your own server."

### 9.3 Pillar one-liners
- **Hands-on workers, not chatbots** — they do the job (write the email, run the script, update the CRM). They don't just suggest things.
- **You stay the boss** — anything risky waits for your nod. Costs are capped. Bad changes roll back.
- **They work with what you have** — Stripe, Slack, Gmail, your CRM, your tools. No platform to learn.

### 9.4 Use-case sample tasks (rotate; keep concrete)
- "✓ Sent 47 outreach emails"
- "✓ Replied to 12 customer tickets"
- "▸ Drafting weekly newsletter"
- "✓ Posted to LinkedIn + X"
- "✓ Reconciled Stripe payouts"
- "▸ Building landing page (3 of 5 sections)"
- "✓ Daily competitor brief in your inbox"
- "✓ Filed invoice batch — €4,820"

### 9.5 CTAs (verbs, never "Get started")
- **Primary**: "Hire your team" / "Start your studio" / "Open the bathhouse"
- **Secondary**: "See a typical day" / "See them at work" / "Read the workshop tour"

### 9.6 Empty-state lines (dashboard / docs)
- "Quiet morning. Nobody's working yet. [Hire someone]"
- "Tofu hasn't sent any outreach today. Want to set the goal?"
- "Sumi is waiting for inbox access. [Connect Gmail]"

### 9.7 Banned phrases (immediate rewrites)
| Wrong | Right |
|---|---|
| "Powered by AI" | (cut) |
| "Next-generation infrastructure" | "your studio" |
| "Modular runtime" | "your team can use Claude or OpenAI" |
| "92 MCP tools" | (cut entirely from marketing) |
| "Tamper-proof audit ledger" | "Every action is logged. You can replay any day." |
| "Encrypted mesh" | "Your servers can talk to each other privately" |

---

## 10. Psychological angles — why each piece works

### 10.1 The hero
**Hook**: "Hire your AI workforce." → reframes AI from *tool* to
*employee*. Employees do work. Tools require operators.

**Subline**: lists six departments by name. Reader sees their org chart;
spends one second thinking "I need a sales person", recognizes the
promise.

**Hero scene**: pencil + pixel of the bathhouse. Two layers of
emotional read — "this is friendly" (pastel watercolor) and "this is
real, look, it's working" (live task cards drifting). No corporate
shine. The viewer leans *in*.

### 10.2 The pillars
Order matters: capability → control → composability. The drowning
founder needs *capability* first ("they actually do the work"). The
agency operator needs *control* ("nothing risky without my nod"). The
dreamer needs *composability* ("connects to my Stripe / Slack / Gmail").

### 10.3 The use-case grid
Concrete tasks > abstract descriptions. "Sent 47 outreach emails"
sells better than "Sales automation". Numbers that look real (47, not
50) feel real.

### 10.4 The two-path section
Critical: covers archetypes A+C ("manage existing") AND archetype B
("build new"). Without this, half the audience bounces. Cofounder.co
only addresses B. We don't.

### 10.5 The typical day
Story > spec sheet. A timeline of 7am to 11pm with concrete tasks
delivers what hours of feature copy can't: *the lived experience of
having a workforce*. The reader can place themselves in that day.

### 10.6 Pricing
Team-size phrasing ("up to 4 workers") not CPU/RAM. Memory note locked
this in. The customer is hiring, not provisioning.

### 10.7 The open + yours section
Speaks to the burned-by-SaaS reflex. "Cancel anytime, take everything
with you" is more reassuring than "GDPR compliant". Open source is a
*proof artifact*, not a boast.

### 10.8 The footer
Quiet. Sign-in, github, telegram, discord. No "Trusted by 10,000
businesses" — we don't have 10,000 businesses. Honesty earns trust.

---

## 11. Frontend stack

- **Pure HTML + inline CSS + small inline JS.** No React for the
  marketing site. Speed > tooling.
- **Design tokens** in `:root` CSS variables (the table in §7.1).
- **Components** echo shadcn (rounded-md = 10px, focus rings, neutral
  borders, generous spacing scale 4/8/12/16/24/32/48/64/96).
- **Inline SVG** for all illustrations (pencil + watercolor + pixel
  sprites). No external images.
- **Font loading**: Google Fonts via `<link rel=preload>` for Fraunces +
  Geist + Geist Mono.
- **No tracking other than the existing GA tag**.

When the dashboard rebuild lands later, *that* one will be Next.js +
shadcn. The marketing site stays plain HTML. Different surfaces, different stacks.

---

## 12. The contract: what we promise, what we don't

We promise:
- A team of AI workers, hired by the role, running on your server.
- They do the work. End-to-end. They don't just suggest.
- You're the boss. Risky things wait for your nod. Costs cap.
- Open source engine. Your data, your server, take everything with you.
- $14.99–$125.99/mo. Pay in USDC.

We do not promise:
- AGI / AI consciousness / "it just works for any job".
- Replacing every human in your business.
- Zero supervision. (You're still the boss.)
- A free tier. (We have a $14.99 floor — honesty about cost.)

If a piece of copy implies something we don't deliver, kill it.

---

## 13. Maintenance

Every quarter, audit:
- Headlines on the home page → still match this book?
- Use-case grid → tasks still feel current?
- Mascot system → consistent across home + dashboard + emails?
- Banned-vocabulary scan → grep for "daemon|MCP|runtime|infrastructure" in marketing surfaces; should return zero hits.

This book is the source of truth. If a marketing surface contradicts
it, the surface is wrong.
