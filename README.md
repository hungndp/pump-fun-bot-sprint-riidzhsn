# pump-fun-bot-sprint-riidzhsn

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hungndp/pump-fun-bot-sprint-riidzhsn/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hungndp/pump-fun-bot-sprint-riidzhsn/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A volume-spike rider for the pump.fun paper-trading replay: it buys only when buy SOL in the last 25 slots is at least 2.5x the preceding 150-slot base window, with price momentum, broad buy pressure and a sane reserve band, then exits on a tight stop (-8%), take-profit (+22%), trailing stop, fade, time stop or dead coin. A drawdown gate halts entries past 15%, tightens stops past 25% and flattens everything past 35%; coverage tiers relax the entry bar until 20 round trips of at least 0.01 SOL are banked. Paper trading only, 10 SOL, on the 6-hour forward window the house records after entries close.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ebjdb2tv&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
