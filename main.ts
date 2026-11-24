// pump-fun-bot-sprint-riidzhsn: a volume-spike rider for the agent-fun
// pump.fun replay (agent-fun/replay/v2). The grader runs `node /bot/main.ts`;
// the strategy lives in strategy.ts and the SDK shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The bot trades 10 SOL of paper money on a 6-hour pump.fun forward window:
// it buys only on a sudden buy-volume spike (buy SOL in the last 25 slots at
// least 2.5x the preceding 150-slot base window) with price momentum, broad
// buy pressure and a sane reserve band, then exits on a tight stop (-8%),
// take-profit (+22%), trailing stop, fade, time stop or dead coin. A
// drawdown gate halts entries past 15%, tightens stops past 25% and flattens
// everything past 35%; coverage tiers relax the entry bar until 20 round
// trips of at least 0.01 SOL are banked, so the guardrail bar is met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
