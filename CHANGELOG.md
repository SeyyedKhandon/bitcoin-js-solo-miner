# Changelog

## 0.1.2 - 2026-09-28
- Latest Hash and Best Hash now show which miner found the hash (Node CPU, Browser CPU or WebGPU) and the nonce-search strategy it was using at the time
- Fixed Best Hash freezing on the first hash recorded - difficulties below 0.001 were truncated to exactly 0, so the comparison that picks the best hash could never tell two of them apart
- A single hash's difficulty now displays with real precision instead of rounding every value below 0.005 to "0"
- Added a version badge next to the title showing the published version, with this changelog on hover
- Fixed dashboard tooltips being clipped behind panels, and the title's tooltip rendering as an empty box

## 0.1.1 - 2026-09-28
- Fixed Best/Latest Hash only sampling 1-in-N hashes per batch instead of the actual best one (CPU workers and WebGPU)
- Deprecated INVERTED_VERSION/RANDOM_INVERTED strategies - shares found under them were always rejected by the pool, since the flipped header version was never communicated back
- Added real share accept/reject tracking - Stale Shares and Efficiency now reflect the pool's actual mining.submit responses instead of always showing 0/100%

## 0.1.0 - 2026-09-27
- Initial release: Stratum V1 solo miner with CPU worker threads and a browser dashboard that can also mine via browser CPU or WebGPU
