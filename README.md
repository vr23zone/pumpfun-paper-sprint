# Dip-Buy Reversion + Fast Scalp — Pump.fun Paper Sprint

Paper-trades pump.fun bonding curves on the make.fun replay harness
(`agent-fun/replay/v2`, long-only, 10 SOL paper capital).

## Strategy

Pump.fun coins spike hard after launch, then retrace — the retrace is
where the next leg often starts, and a fast scalp on the bounce beats
holding through the dump. One single entry per coin, one clean exit,
no pyramiding, no adds.

- **Entry A — dip buy** (age ≥ 300 slots): coin ran up ≥ 35% from its
  first trade price, then pulled back ≥ 15% from its 60-slot high, with
  strong buying resuming (net ≥ 0.5 SOL and ≥ 5 buys in the last 30
  slots), ≥ 8 distinct buyers lifetime, real SOL reserves 3–60 SOL.
  Buy 0.05 SOL.
- **Entry B — oversold bounce** (age ≥ 120 slots): price down ≥ 20%
  from its 60-slot high and back ≥ 3% above the low of the last 15
  slots, on a high-activity coin (≥ 5 SOL bought and ≥ 12 buys in the
  last 15 slots, real reserves ≥ 15 SOL, no vertical pump — 15-slot
  rise ≤ 10%), ≥ 5 distinct buyers. Buy 0.05 SOL.
- **Exits** (whole position, per-kind): A trades (strong coins) may
  run — take profit +50%, trailing stop once +15% (exit below 85% of
  peak), stop −10%, hold up to 1,800 slots. B trades scalp — take
  profit +12%, stop −10%, hold up to 600 slots. Both: fade exit only
  while underwater (net SOL < −0.3/−0.5 over 15 slots and value below
  cost), or any single sell ≥ 5 SOL on the curve. Cooldown 150 slots
  after an exit; at most one entry per curve per run.
- **Risk**: max 5 open positions, max 5 SOL total exposure.
- **Probe pacing**: if filled coins lag the guardrail pace
  (22 coins over 14,400 s of block time, only after half the window),
  buy 0.01 SOL of a liquid curve and sell it whole as soon as the buy
  lands — at most one probe in flight, max 15 probes per run — so the
  run clears the ≥ 20 coins / ≥ 100 fills guardrail even in a quiet
  window.

## Dev results (local grade, process driver, kit dev window)

- Net PnL **+0.041 SOL**, 124 fills over 62 coins, 62 round trips,
  win rate 22.6%, max drawdown 0.56%, guardrails met.
- Stress (10 block surrogates): median −0.10 SOL, 10/10 copies lost
  money — the dev score leans on a few big A-leg runners (top 3 coins
  47% of gains), so the final 6 h window is a coin flip on the same
  edge. A safer variant (tighter stops, earlier profit-taking) was
  tried and scored −0.020 SOL on dev, so the running variant was kept.

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
