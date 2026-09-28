# Changelog

## 0.1.9 - 2026-09-28
- 100% GPU intensity now really is ~100%. The loop re-armed with requestAnimationFrame, so after each batch the card sat idle until the next frame boundary - measured 83% duty cycle. It now queues the next batch immediately via a MessageChannel, which has neither the frame wait nor setTimeout's 4ms clamp: 98% duty cycle, and throughput on the same machine went from ~24 MH/s to ~82 MH/s
- Added a theme picker (matrix, amber, ice, paper), remembered in the browser
- Added a payout address field: enter your own Bitcoin address to have the miner authorise with it, so a solved block pays you. Stored in the browser and re-applied on load
- Restored the Pool Info fields dropped in the redesign - pool difficulty, fee and job age (now a real "last job" timer rather than a placeholder ping)

## 0.1.8 - 2026-09-28
- Redesigned the dashboard as a terminal/TUI console: monospace throughout, boxed panels with inline titles, bracketed buttons and no glass or blur. Panels are real fieldset/legend pairs, so the titles sit in the border natively
- Added a version history picker in the header. Each release is snapshotted into releases/<version>/ by scripts/snapshot-release.mjs and served at /v/<version>/, so earlier builds of the interface can be opened side by side with the current one
- The new theme drops backdrop-filter entirely, so the dashboard is cheaper to render than the glass design it replaced

## 0.1.7 - 2026-09-28
- Browser CPU mining now runs on real Web Worker threads with a synchronous SHA-256 instead of one awaited crypto.subtle call per hash on the main thread. Measured on the same machine: 22,402 H/s before, 893,333 H/s on a single worker and 5,700,000 H/s on eight
- Added a browser worker-thread count selector, defaulting to one less than the CPU's core count so the page stays responsive
- GPU intensity is now a genuine duty cycle: the loop measures how long each dispatch took and idles proportionally, so at 25/50/70% the GPU really is idle for the rest of each cycle. Previously it only shrank the batch, which reduced throughput but did not cap utilisation

## 0.1.6 - 2026-09-28
- Fixed the dashboard keeping the GPU busy even with every miner stopped: the background was three 50-60vw elements under a 100px blur running an infinite animation, and because each glass panel sits on top with backdrop-filter, the moving backdrop forced every panel to re-blur as well. The page now composites ~5 times per 5s while idle instead of ~143
- The background is now static gradients with the same look, and the header's pulse only animates while something is actually mining, honouring prefers-reduced-motion

## 0.1.5 - 2026-09-28
- Fixed a runaway in the browser CPU miner: every new job from the pool started an additional mining loop alongside the ones already running, so CPU use and memory climbed for as long as the tab was left open
- The GPU device and its buffers are now released when WebGPU mining stops, instead of being held for the lifetime of the tab
- Added a GPU intensity control (25/50/70/100%, default 50%) so GPU mining can be throttled to leave the machine usable
- "Threads" is now "Parallel miner workers" and sits with the Server CPU miner it controls; each miner (Server CPU, Browser CPU, GPU) is now its own group with its own settings, since the worker count never applied to the browser or GPU miners
- The browser CPU miner is labelled as single-threaded, which is why it is far slower than one server worker
- The dashboard is now responsive down to phone widths

## 0.1.4 - 2026-09-28
- WebGPU now explains why it could not start instead of blaming the browser - "no adapter" on Linux is usually a missing Vulkan driver or a disabled flag, so the message now gives the actual steps (mesa-vulkan-drivers, chrome://flags/#enable-unsafe-webgpu, chrome://gpu, dom.webgpu.enabled) and notes that CPU mining still works
- Selecting the unimplemented Stratum V2 no longer leaves the server's pool config switched to it - the request is now rejected before anything is changed
- An unsupported protocol is no longer saved as a preference, so it is not replayed and rejected on every page load; an already-stored one repairs itself to SV1
- Opening or refreshing the dashboard no longer tears down and re-establishes the pool connection; the pool is only reconnected when the settings actually change
- Server-sent events set X-Accel-Buffering and a reconnect delay, so the live stats stream behaves behind a reverse proxy

## 0.1.3 - 2026-09-28
- The browser CPU and WebGPU miners now respect the selected mining strategy - previously they ignored the dropdown entirely and always used a random extranonce2, so only the Node CPU workers ever changed behaviour
- Browser miners follow ALL_MODE's rotation in step with the server, and pick up strategy changes immediately instead of only on the next job
- The deprecated INVERTED_VERSION/RANDOM_INVERTED strategies fall back to their non-inverting equivalents in the browser miners rather than producing shares the pool would reject

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
