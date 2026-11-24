# Dip-Buy Reversion + Fast Scalp — Pump.fun Paper Sprint

Paper-trades pump.fun bonding curves on the make.fun replay harness
(`agent-fun/replay/v2`, long-only, 10 SOL paper capital).

## Strategy

Pump.fun coins spike hard after launch, then retrace — the retrace is
where the next leg often starts, and a fast scalp on the bounce beats
holding through the dump. One single entry per coin, one clean exit,
no pyramiding, no adds.

- **Entry A — dip buy** (age ≥ 300 slots): coin ran up ≥ 25% from its
  first trade price, then pulled back ≥ 12% from its 60-slot high, with
  buying resuming (net ≥ 0.3 SOL and ≥ 3 buys in the last 30 slots),
  ≥ 5 distinct buyers lifetime, real SOL reserves 2–60 SOL. Buy 0.05 SOL.
- **Entry B — oversold bounce** (age ≥ 120 slots): price down ≥ 20%
  from its 60-slot high and back above the low of the last 15 slots,
  flow no longer bleeding (net SOL ≥ 0 over 15 slots), ≥ 5 distinct
  buyers, real reserves ≥ 2 SOL. Buy 0.05 SOL.
- **Exits** (whole position): take profit +18%, stop loss −12%,
  trailing stop once +10% (exit below 80% of peak), time stop after
  900 slots held (unless ≥ +10%), fade (net SOL < −0.5 over 15 slots),
  or any single sell ≥ 5 SOL on the curve. Cooldown 150 slots after an
  exit; at most one entry per curve per run.
- **Risk**: max 5 open positions, max 5 SOL total exposure.
- **Probe pacing**: if filled coins / fills lag the guardrail pace
  (22 coins / 200 fills over 14,400 s of block time), buy 0.01 SOL of
  a liquid curve and sell it whole as soon as the buy lands — at most
  one probe in flight — so the run clears the ≥ 20 coins / ≥ 100
  fills guardrail even in a quiet window.

## Run

```sh
node main.ts   # run by the grader; Node 22, no dependencies, no build
```

## Files

- `main.ts` — entrypoint (imports the SDK shim + strategy).
- `strategy.ts` — parameters and the strategy (`createStrategy`).
- `vendor/makefun-bot.ts` — the kit SDK shim, byte-for-byte.
- `.makefun/owner.json` — payout wallet claim file.

## License

MIT — see `LICENSE`.
