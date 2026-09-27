# Changelog

## 0.1.1 - 2026-09-28
- Fixed Best/Latest Hash only sampling 1-in-N hashes per batch instead of the actual best one (CPU workers and WebGPU)
- Deprecated INVERTED_VERSION/RANDOM_INVERTED strategies - shares found under them were always rejected by the pool, since the flipped header version was never communicated back
- Added real share accept/reject tracking - Stale Shares and Efficiency now reflect the pool's actual mining.submit responses instead of always showing 0/100%

## 0.1.0 - 2026-09-27
- Initial release: Stratum V1 solo miner with CPU worker threads and a browser dashboard that can also mine via browser CPU or WebGPU
