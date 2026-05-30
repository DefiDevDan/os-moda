# I gave Claude root on my server. It did not destroy anything.

Not because Claude is good. Because the surface around it is built right.

I run a one-person company on a $14.99/mo Hetzner box. The server's name is `osmoda-9b542eca`. It writes my email replies, reconciles my Stripe payouts, opens GitHub PRs, deploys little apps when I ask, and watches my crypto positions overnight. It runs as root. The audit log says it has executed 18,422 distinct mutations across the system since I bought it. The disk is fine. The bank account is fine. I don't have backups because I haven't needed them.

Most agentic AI products feel fake because they are. The "tools" the agent calls are usually sandbox stubs that fake-write to a fake-filesystem and call themselves agentic. The agent has no continuity, no memory between sessions, no real network. It can't sign a transaction. It can't `systemctl restart` anything. It can't even keep a file you asked it to keep yesterday.

That's not what agency means. Agency means a body. The brain — the LLM — already exists. Anthropic and OpenAI sell those by the token. What's been missing is the body: a machine the model can actually touch, with constraints that make touching it safe.

So I built one. Then I ran into 47 production bugs in the first six weeks. Here's what each of those bugs taught me, and why the result is the first agent setup I trust.

## Trust tiers, not sandboxes

The standard AI-agent advice is "sandbox everything." That's wrong. Or rather, that's right for the *parts where you don't trust the code*. The model itself, talking to your own files, on your own server — that's not the threat. The threat is the npm package the model installs because it sounded plausible.

So we have three tiers:

- **Tier 0 — the agent.** Full root. It can `rm -rf /`. It can `passwd root`. It can install packages, edit `/etc`, restart services. We don't sandbox it because we want it to actually do work.
- **Tier 1 — approved apps.** Sandboxed via `bubblewrap`. Declared capabilities only.
- **Tier 2 — untrusted tools.** Maximum isolation. No network. Minimal filesystem.

The agent is the user. The user is supposed to have root. We protect against the *third-party* code, not the *first-party* user.

## Hash-chained audit ledger (the part that makes me sleep)

Every system mutation goes through a daemon called `agentd`. Before the call executes, agentd writes an event row to a SQLite table:

    id     | ts                  | type             | actor   | payload | prev_hash | hash
    18422  | 2026-05-06T11:14:28Z | api_key.delivered | agentd  | {…}    | 8f3a…    | a4e1…
    hash = SHA-256(id|ts|type|actor|payload|prev_hash)

If you tamper with row 18,401, every hash from 18,402 onward becomes invalid and you can prove the chain broke. I can run `agentctl verify-ledger` and get a signed proof of integrity. SOC 2 evidence collects itself. HIPAA's "tamper-evident logs" requirement is satisfied. 21 CFR Part 11 audit trail — done.

This isn't a feature. This is the only reason giving an LLM root is a sane idea.

## NixOS atomic rollback (the part that makes me not panic)

Every system change creates a NixOS generation. If the agent does something stupid — which it has, and will — I run `nixos-rebuild switch --rollback` and the machine is back to 30 seconds ago. Filesystem, services, kernel modules, everything.

This is git for your operating system. The agent can experiment because experiments are free. I've watched it install five conflicting Python tooling configurations in a row trying to fix a dependency issue, then revert when nothing worked. No state damage. No "well, I guess we reinstall now."

## The wallet that keeps secrets

`osmoda-keyd` is a separate Rust daemon that runs with `PrivateNetwork=true`. It owns my crypto keys. The agent has full root on the system *except* it cannot exfiltrate the keys because keyd has no network access and won't return private material — only signed payloads.

The agent can: sign a transaction up to my daily cap, on an allowlist of addresses, with a receipt logged to the ledger.

The agent cannot: read the raw key bytes, change the daily cap, or remove an allowlisted address.

The interface looks the same to the LLM (a `wallet_send` tool). The constraints are enforced *outside* the LLM's context, by a daemon the LLM can't talk to.

This is how you give an AI a credit card without giving it your wallet.

## A real bug, in case you think this all sounds clean

Last week one customer's spawn failed mid-install. The error: `error during placement`. Cryptic Hetzner-speak. I dug in:

The order requested server type `cx22`. Hetzner had retired `cx22` weeks ago without telling us. Our static plan-to-type mapping pointed at it. The user got charged $29. The auto-refund code marked the order refunded but the actual user-balance write failed silently — a `withFileLock`-queued promise that wasn't being awaited. The customer had a charged account with no server and no refund.

I shipped five guardrails over the next 90 minutes:

1. **Plan validator** — on boot and every 15 min, cross-check every plan against the live Hetzner catalog. Greyed-out badge in the UI if anything's broken.
2. **Pre-flight gate** — block the charge if the validator says the plan is dead.
3. **Refund write-then-verify** — push transaction, save, reload, confirm the txn landed. Retry once. Fall back to a `refund_pending` flag if the disk-write race happens.
4. **Refund sweeper** — every 5 min, scan for `refund_pending: true` and retry. Self-healing.
5. **Upstream error mapping** — `error during placement` → `out_of_stock`. `not_found` → `server_type_retired`. The spawn-log surface gives ops the actual cause, not a wrapped string.

Each layer is independent. Even if the validator crashes (#1), the gate (#2) still works. Even if the gate has a bug, the verify (#3) catches it. Even if verify fails, the sweeper (#4) eventually heals.

This is what ops engineering looks like when the AI agent is a load-bearing part of your product. You don't trust any one layer. You compose layers that each fail safely.

## The modular-runtime trick

Different LLMs have different vibes. Claude is calmer, GPT is faster, OpenClaw is honest about uncertainty. I want to switch them per-task, not per-account.

So the gateway is a TypeScript HTTP+WS server with a `drivers/` folder. Add a file, get a runtime. Configure agents in JSON, hot-reload via SIGHUP, in-flight WebSocket sessions keep their snapshot — zero drops. The dashboard exposes credential management as a tab; you paste an OAuth or API key, click default, and the next chat uses that runtime.

Bring your own Anthropic key. Bring your own OpenAI key. Bring your own self-hosted Llama. Same machine, same audit log, same wallet, same tools.

## What this gets you that nothing else does

- **A real machine you own.** Not a Manus container that runs on someone else's terms. It's your VM, your IP, your audit log, your kill switch. EU-hosted by default. Take it home any day.
- **Continuity.** The agent remembers what it did yesterday because there is a *yesterday*. Files persist. Skills persist. The teachd daemon detects repeated tool sequences and writes new skills automatically — the system gets better at the things you keep doing.
- **No vendor moat.** Apache-2.0. The whole stack is on GitHub. If we go away, you `git clone` and run it on whatever cloud you want. Your data is yours.
- **Predictable cost.** $14.99/mo for a small one. $34.99/mo for the most popular tier. The model keys are yours, billed by you to Anthropic or OpenAI directly. No metering surprises.

The whole thing — 10 daemons, 92 typed tools, 20 skills, a post-quantum mesh, a hash-chained ledger, atomic rollback, a hardware-isolated wallet — is what the AI body should look like. Most companies are still arguing about whether agents should have memory. We've been running them with memory and root and a paycheck for six weeks.

## What's next

The interesting unsolved problem is not capability. The model can do almost anything you ask. The interesting problem is *trust at scale* — when 100 agents are running on 100 servers, talking to each other through the post-quantum mesh, signing transactions, writing code, the audit trail is what holds the whole thing together. Hash chains compose. Constitutions compose. Skills compose.

The brain has been ready for a year. The body is starting to catch up.

---

Code: [github.com/bolivian-peru/os-moda](https://github.com/bolivian-peru/os-moda) · Apache-2.0
Live: [spawn.os.moda](https://spawn.os.moda) · From $14.99/mo · 15 min install
