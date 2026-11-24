// Dip-Buy Reversion + Fast Scalp — pump.fun paper sprint entry.
// Paper-trades pump.fun bonding curves on the replay harness: buys the
// dip after a run-up + pullback (or an oversold bounce forming a higher
// low), then scalps out fast on take-profit / stop / trailing / fade /
// big-sell / time-stop exits. One entry per coin, no adds, no pyramiding.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onHello(state) {
    console.error(
      `dip-reversion bot started: capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, latency ${state.hello.latency_slots} slots`,
    );
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state, done) {
    console.error(
      `done (${done.reason}): cash ${state.cash} lamports, ` +
        `${state.positions.size} positions left, ${state.curves.size} curves seen`,
    );
    console.error(`BOT-STATS ${JSON.stringify(strategy.stats)}`);
    console.error(`BOT-TRADES ${JSON.stringify(strategy.stats.trades)}`);
  },
});
