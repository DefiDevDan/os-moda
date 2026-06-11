# Liquid Software — the os.moda thesis

> *Software that has no final form. It is continuously generated, deployed, and improved
> by an AI agent in near-real-time, in response to intent — and it is safe to change
> because the substrate it runs on is transactional, so every change is verified,
> reversible, and audited.*

This is the thesis behind os.moda. Not "a server that manages itself," not "a chatbot with
sudo." A new **state of matter for software**.

---

## 1. The metaphor: software has phase states

Think of software the way physics thinks of matter.

- **Solid software** — the default for 50 years. You compile it, ship it, freeze it. To
  change its shape you melt the whole block down and recast it: a release cycle, a sprint,
  a deploy. Between releases it is rigid. Most of the world's software is a quarry of solid
  blocks.
- **Gel software** — SaaS. It updates centrally and flows a little, but it is *someone
  else's* shape. You rent a fixed form and hope it bends toward your need. You cannot reach
  in and reshape it; you file a feature request and wait a quarter.
- **Liquid software** — software held at its phase transition. It stays **molten and
  reshapeable on demand**, taking the shape of whatever intent is poured into it, then
  re-solidifying into a known-good state after each change — and melting again the moment
  the need changes.

Two things are required to hold software at that transition, and **both only became real in
2026**:

1. **Heat — a generative model capable enough to keep software molten in near-real-time.**
   The model has to read a system's own code, understand it, plan a change, write it, deploy
   it, and verify it — in seconds to minutes, not a sprint. **Fable 5 is that heat.** It is
   the first model fast *and* capable enough that the molten state is the *resting* state,
   not a brief, expensive flicker. Turn the heat down (a weaker model) and the software
   freezes — it can no longer reshape itself.
2. **A crucible — a substrate where reshaping is safe.** Molten metal without a mould is not
   liquid software, it's lava: it destroys the machine. The crucible is what lets the system
   melt and re-solidify *without ever being in a broken state*. **NixOS is that crucible:**
   every system state is a transaction with a generation number; rollback is one command;
   nothing is ever half-changed.

os.moda is the first system that puts the heat and the crucible together at production grade.
(The repo is even named **molt-os** — *molting*: how a living thing continuously sheds and
regrows its own form without dying. That is the whole idea.)

---

## 2. Definition: the five properties of Liquid Software

Software is *liquid* to the degree it is all five of these at once:

1. **Generative** — produced from *intent*, not authored by hand. You describe the outcome;
   the system writes the implementation.
2. **Self-modifying** — it can change its *own* code and grow its *own* new capabilities,
   not just the apps it hosts.
3. **Continuously deployed** — changes flow live, zero-downtime, no release ceremony.
4. **Reversible & audited** — every change is a transaction: health-verified, instantly
   revertible, and recorded in a tamper-evident log. *This is the hard one. It is the whole
   game.*
5. **Ambient** — it is not trapped in one window. It follows the user across channels
   (web, Telegram, WhatsApp, voice) and across machines (an encrypted mesh of boxes).

Most "AI app builders" hit property 1 and stop. The frontier — and the moat — is properties
**2 and 4 together**: a system that rewrites *itself*, in production, *safely*.

---

## 3. The intellectual lineage — four visions, each missing one piece

Liquid software is not a brand-new idea. It is the convergence of four research lineages that
each saw part of it and each lacked exactly one component. The 2026 stack supplies all four
missing pieces at once.

| Vision | What it got right | What it was missing | os.moda supplies |
|---|---|---|---|
| **Liquid Software** (JFrog — Simon, Landman, Sadogursky, 2018): software flows like liquid via continuous, automatic, zero-downtime updates | The *flow* — continuous trusted updates, no human in the loop | **The author.** Who *writes* the endless stream of updates? They assumed humans upstream. | The agent (Fable 5) authors the updates |
| **Liquid Software Manifesto** (Taivalsaari, Mikkonen, Systä, 2014–17): apps + data flow seamlessly across all your devices | The *ambient* property — software roams with the user | **The generator.** The apps still had to be hand-built before they could flow. | The agent generates the apps; the mesh + named chats flow them across channels/boxes |
| **Malleable Software** (Ink & Switch — Litt, Horowitz, van Hardenberg, Matthews, 2025): software you reshape at the point of use, in natural language | *Generative* + *self-modifying*, and named LLMs as the missing enabler | **The safe substrate at the systems level.** Their prototypes were personal, local, sandboxed — not a production machine with root. | A transactional OS + root agent + audit + rollback: reshape the *whole system*, safely |
| **Darwin Gödel Machine** (Sakana AI, ICLR 2026): an agent that rewrites its *own* code and empirically validates each change, growing an archive of better selves | *Self-modifying* with empirical validation — true open-ended self-improvement | **Production safety + trust + a business.** A research loop on benchmarks, not a box a company can run its operations on. | NixOS atomicity + the ApprovalGate + the hash-chained ledger + single-tenant isolation = a *productionised, safe* self-improving machine |

Read the right-hand column top to bottom: **os.moda is what you get when all four missing
pieces exist simultaneously.** That is why it is possible now and was not possible in 2018,
2017, or even early 2025.

---

## 4. How os.moda already *is* liquid (mechanism by mechanism)

This is not aspiration. Map each property to code that exists in this repo today:

**Generative**
- `spec-driven-development` (github/spec-kit) is baked into **every** spawn: `specify init →
  plan → implement`, agent-driven, on every box.
- `app_deploy` turns "deploy my Node API" into a managed, isolated systemd service
  (`DynamicUser`, resource caps) in one structured tool call.
- 92 typed agentd tools give the agent *structured* access to the whole machine — no shell
  guessing — so generation is reliable, not brittle.

**Self-modifying** *(the rare one)*
- **`teachd` skillgen loop**: every 6 hours it scans the agent's own tool-call history,
  finds sequences repeated across ≥3 sessions, and **auto-generates a new `SKILL.md`**, then
  promotes it to auto-activation. *The system literally writes new permanent capabilities for
  itself from watching itself work.* This is a productionised, bounded Gödel-machine step.
- **CodeGraph** pre-indexes `/opt/osmoda` — the OS's *own source* — alongside `/workspace`
  and `/srv`. The agent navigates and edits itself with a knowledge graph, not grep.
- The agent edits NixOS config — i.e. it reshapes the very substrate it runs on.

**Continuously deployed**
- **SafeSwitch** (`osmoda-watch`): deploy behind a timer + health checks; if any check fails,
  automatic rollback to the previous generation. This is *exactly* the "trusted continuous
  update" JFrog described in 2018 — now with an AI as the author and NixOS as the guarantor.
- systemd + NixOS generations = zero-downtime, every change a numbered, switchable state.

**Reversible & audited** *(the crucible — the hardest property, and the one we spend the most
engineering on)*
- **NixOS atomic rollback** — any change reverts to a prior generation in one command.
- **Hash-chained audit ledger** (agentd) — every mutation is SHA-256-chained, tamper-evident,
  offline-verifiable.
- **ApprovalGate + the new PreToolUse hook** — the agent's *native* Bash/Write/Edit now route
  through a destructive-command gate + the ledger, so even the model's own hands are inside
  the crucible, not outside it.
- **Single-tenant isolation** — one box, one operator, one agent. The liquid is contained.

**Ambient**
- **Named chats + cross-channel awareness** — one continuous conversation that follows you
  across web, Telegram, WhatsApp, voice, each with its own persistent session + transcript.
- **`osmoda-mesh`** — post-quantum-encrypted box-to-box channel: the liquid flows between
  machines, not just within one.

---

## 5. The liquid loop — the metabolism of a self-improving system

What makes it *liquid* rather than just "an agent that can deploy" is that these mechanisms
form a closed metabolic loop that runs on demand and tightens over time:

```
        intent  (chat / Telegram / voice / API / a routine firing on its own)
          │
          ▼
   ┌──────────────┐   Fable 5 plans against CodeGraph's map of the system's own code
   │   GENERATE   │   → writes/edits code, NixOS config, a new app, or a new skill
   └──────┬───────┘
          ▼
   ┌──────────────┐   SafeSwitch deploys behind health gates  ── the crucible ──
   │    DEPLOY    │   PreToolUse gate + ApprovalGate screen destructive steps
   └──────┬───────┘
          ▼
   ┌──────────────┐   health checks pass?
   │    VERIFY    │      ├─ yes → commit; hash-chain the change to the ledger
   └──────┬───────┘      └─ no  → atomic rollback to the last good generation
          ▼
   ┌──────────────┐   teachd observes the action trail; if a useful sequence recurs,
   │    LEARN     │   skillgen CRYSTALLISES it into a permanent SKILL.md
   └──────┬───────┘   → the system is now permanently better at this
          │
          └────────────► next intent meets a system that has already improved
```

Solid software has no metabolism — it is inert between releases. Liquid software has one. The
loop is why the fifth time you ask for something, the system is better at it than the first —
**it has metabolised the work into itself.**

---

## 6. Why this is *for companies* — the business thesis

A company does not buy an *app* from os.moda. An app is solid — frozen the day it ships,
already drifting from the business the day after. A company buys a **liquid substrate that
becomes whatever the business needs, continuously.**

- **You hire it, you don't license it.** It is closer to an employee than a tool: give it
  access to your systems, tell it the outcomes you want, and it builds, deploys, and improves
  the internal tools to get there — and keeps improving them as it learns your patterns.
- **"Jarvis that plugs into your company"** is the concrete shape: connectors feed it your
  data (Slack, Google Workspace, GitHub, your DB); the liquid engine reshapes itself around
  *your* workflows; it stands up the internal apps you need on demand and metabolises the ones
  you use often into permanent, reliable skills.
- **The moat is the medium, not the apps.** Anyone with an API key can generate a frozen app
  (Bolt, v0, Lovable — 2026 is full of them). Almost no one can let software rewrite *itself
  in production safely*. The defensible asset is the **safe liquid substrate**: the
  transactional OS + the audit ledger + the approval gate + single-tenant isolation. The apps
  are ephemeral by design; the crucible is the product.
- **Each box gets more valuable the longer it runs.** teachd's skill crystallisation means a
  six-month-old box is *not* the same product a competitor's fresh box is — it has metabolised
  six months of your company's work into bespoke capability. That is a compounding moat that a
  shared-tenant SaaS structurally cannot have.

---

## 7. The hard problem is trust — which is why the "boring" hardening *is* the product

Here is the load-bearing insight, and it is the same one JFrog named in 2018: **the hard part
of liquid software is not the flow, it is the trust.** "Trusting automatic updates cannot be
taken for granted; robust security must confirm the safety of software streamed to systems,
and quality must improve so companies are confident it will not break existing systems."

You cannot let software continuously rewrite itself in production *unless every change is
safe, verified, reversible, and audited.* So the entire trust-and-durability effort — the
PreToolUse approval hook, atomic encrypted-store writes, SafeSwitch health gates, the
hash-chained ledger, egress confinement, the spend kill-switch, per-box SSH keys — is **not a
detour from the liquid-software vision. It is the crucible.** Keep the metal molten without a
sound crucible and you don't have liquid software, you have a melted server.

This reframes the whole roadmap:
- **Phase 1 (the trust floor)** = *make the liquid safe to keep molten.* Without it, "software
  that rewrites itself with root" is a liability, not a product.
- **Phase 3 (connectors + knowledge)** = *give the liquid your company's shape to flow into.*
- Everything else = *make the crucible hold at fleet scale* (HA, drift reconciliation, audit
  export, SOC2).

The order is not negotiable: **crucible first, then heat.** That is exactly the order the work
is in.

---

## 8. Honest state — what is liquid today, what is still solid

To keep this a thesis and not a pitch:

- **Already liquid:** app deployment on demand, self-skill-generation (teachd), self-source
  awareness (CodeGraph), atomic transactional reshaping (NixOS + SafeSwitch), the audit
  crucible (ledger + the new PreToolUse gate), ambient presence (named chats + mesh).
- **Still solidifying:** the trust floor is *implemented but not all live-verified* (the
  PreToolUse gate ships but needs a real box test before we claim "enforced"); the
  company-knowledge/connector layer — the thing that lets the liquid take a *specific
  company's* shape — is the next build, gated behind confined egress; and the control plane
  that makes this *buyable* by an organisation (multi-org, SSO, billing, Postgres durability)
  is still ahead.
- **The honest one-liner:** os.moda already demonstrates every property of liquid software in
  isolation. The work between here and "the go-to AI liquid software for companies" is making
  the crucible trustworthy enough, and the connectors rich enough, that a company can pour its
  whole operation into it and trust what comes back out.

---

## 9. The thesis, in one breath

For fifty years software was solid: cast once, frozen until the next release. SaaS made it a
gel — fluid, but someone else's shape. **In 2026 software can finally be liquid: held at its
phase transition by a model hot enough (Fable 5) to keep it molten on demand, inside a crucible
strong enough (a transactional OS with an audit ledger and an approval gate) to make every
reshape safe, reversible, and trusted. It generates itself from intent, improves itself from
experience, flows to wherever you are, and never freezes into a form that outlives the need.**

os.moda is the crucible and the heat in one box, that a company can hire.

---

### Sources / lineage
- JFrog, *Liquid Software: How to Achieve Trusted Continuous Updates in the DevOps World* (Simon, Landman, Sadogursky, 2018) — https://liquidsoftware.com/
- Taivalsaari, Mikkonen, Systä, *Liquid Software Manifesto* (IEEE COMPSAC 2014) — https://homepages.tuni.fi/antero.taivalsaari/LiquidSoftwareManifesto.pdf
- Ink & Switch, *Malleable Software: Restoring User Agency in a World of Locked-Down Apps* (Litt, Horowitz, van Hardenberg, Matthews, 2025) — https://www.inkandswitch.com/essay/malleable-software/
- Sakana AI / Zhang et al., *Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents* (ICLR 2026, arXiv:2505.22954) — https://sakana.ai/dgm/
- github/spec-kit — specification-driven development (baked into every osModa spawn)
