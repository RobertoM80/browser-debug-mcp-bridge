# Changelog

## Unreleased

### Features

* **automation:** add live document load-state waits for MCP workflows
* **automation:** add navigation lifecycle, download, and popup waits
* **automation:** add native JavaScript dialog waits
* **automation:** add stable layout waits
* **automation:** add ancestor and frame-selector native locator support
* **automation:** add coordinate action targets and explicit closed-shadow diagnostics
* **automation:** harden native actionability for offscreen scroll and detached-target retry
* **automation:** add zero-size geometry diagnostics and richer wait timeout evidence
* **automation:** persist native action diagnostics in automation history
* **automation:** link failure evidence and related snapshots into automation history
* **automation:** extend live e2e coverage for coordinate actions, unsupported frames, and history diagnostics
* **automation:** improve frame reload recovery and frame ambiguity diagnostics
* **automation:** support translated frame-local coordinate actions and native locator state filters
* **automation:** extend live e2e coverage for contenteditable input, Tab navigation, and frame-local coordinates
* **automation:** support explicit descendant relations in native locator chains
* **mcp-server:** add SSR mockability discovery and managed env patch tools
* **mcp-server:** add persisted mock route, run, and hit records with MCP CRUD and status tools
* **mcp-server:** execute browser mock routes through the existing override fulfillment path
* **mcp-server:** serve enabled SSR mock routes from the built-in mock endpoint

## [1.13.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.12.0...browser-debug-mcp-bridge-v1.13.0) (2026-05-22)


### Features

* add lighthouse performance reports ([74cbcaa](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/74cbcaa0b5d10a8851eda182db49f33a1e196259))
* add repo-aware lighthouse fix planning ([2e325ac](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2e325ac24e4bb22405c15e459f50a31dab082c0c))
* **mcp:** add Lighthouse performance reports ([02de923](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/02de923fab7d69a52fdc90cd159141a153036861))

## [1.12.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.11.1...browser-debug-mcp-bridge-v1.12.0) (2026-05-20)


### Features

* add automation preflight and wait tools ([fb7efb6](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/fb7efb61b5d784a9947a83b641842ffeb9191e9c))
* add compact automation locators ([f6b3ecb](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/f6b3ecb168cd6a825c58e7cbe11ec99ee1a24b4f))
* add frame policy diagnostics ([9974e42](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/9974e42605ff5981c5c1615b757a7b371ad5ce7d))
* add native dialog waits ([1b7e239](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/1b7e239e413ccecb2010dd622fc261a26137fcbd))
* add native live automation coverage ([4d06f73](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/4d06f73ac937c16847db71489481d28892637a15))
* add stable layout waits ([6ecd5f0](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/6ecd5f0fecabb5390ca2b49ac7b40ea14848bad6))
* advance live automation parity ([fd04fa1](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/fd04fa1c58f32998eabeece9d0033e89073a9bf9))
* close end-to-end automation parity ([0540ecc](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/0540eccfdc7cae5af51bfcea483f8657201bd159))
* **e2e:** improve end-to-end automation parity ([5167f2c](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/5167f2cd9cad7f1b979760f37de94504412a1708))
* expand end-to-end automation parity ([7f50116](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/7f501161bb5595d144528608246a916b7b8bac44))
* expand live automation locators ([11feee4](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/11feee4b0c9411c0c0c2881efe3fbe3d77a6a8ee))
* expand live automation waits ([c2b82f9](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c2b82f98f9c806fa04a5c99ae8d6a85362372b89))
* extend end-to-end automation diagnostics ([537205d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/537205db01d5a7590bf7d2c730fd97ad9369eb05))
* extend live automation frame and shadow targeting ([a423fc2](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a423fc270ec98624474a3c6e9162224e638ae419))
* harden frame recovery diagnostics ([a51f49b](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a51f49b1ff2fbc39eb5f87629f1a833508140e80))
* harden live automation and override loops ([a85fc17](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a85fc179d6e5dc0d9004496039f510931a601412))


### Bug Fixes

* **override:** enable runtime-controlled overrides by default ([9f6a32d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/9f6a32d0deeff6bb334d337645a13ce4f132aa2d))

## [1.11.1](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.11.0...browser-debug-mcp-bridge-v1.11.1) (2026-05-15)


### Bug Fixes

* add override timeout diagnostics ([5c42517](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/5c425178a0967aa65dd6ea1c462ae821d302d36f))
* harden override capture readiness ([2e1d1f1](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2e1d1f18de356759f5b929f0ec3617bfd77958bd))
* support captured post rsc overrides ([79c5769](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/79c5769db090b71ddac957b5cec43255c7091290))

## [1.11.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.10.0...browser-debug-mcp-bridge-v1.11.0) (2026-05-11)


### Features

* **extension:** support production response overrides ([ba96186](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/ba9618672c874c4db6699ce5368fd7309adab010))
* **mcp-server:** improve live session discovery and health ([672ff7c](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/672ff7c5402d13210c5c11d0ec25e6490934b8ae))
* **override:** harden browser asset overrides ([6a33d59](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/6a33d5924b3ef4e883366386755a060181d25bf6))
* **overrides:** add response planning and audit gates ([379b3bc](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/379b3bce410657137afe8dfcc215cd21543caed3))
* **overrides:** support production Next.js response overrides ([14623ee](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/14623ee8d34d7245fa01e4c3dc46311c8c0cfa8c))


### Bug Fixes

* **redaction:** redact sensitive number sequences neutrally ([bf40176](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/bf401768d5f7cfc3d2c341e448c8e0bb79a85c87))
* update pnpm lockfile ([c64b7ba](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c64b7ba2d52f5709f6b215067371dc657cba6f04))

## [1.10.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.9.0...browser-debug-mcp-bridge-v1.10.0) (2026-03-08)


### Features

* merge branch 'main' ([61cbe62](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/61cbe623bdda95c518985b530dbc75872bbfa72c))
* **test:** add automated test flow ([3515b87](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/3515b872d09844e891e02e54f3a92f2b38ecad1a))
* **test:** add automated test flow ([e9361e4](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/e9361e461d08883c787af60cacd96fc50f68179b))
* **test:** add automated test flow ([f020bbf](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/f020bbf81a1df69d6c6a314ccf81fc6230f915d3))
* **test:** add automated test flow ([0bd7bde](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/0bd7bdea08333ab0b038cd73039e79fd1c2f738c))
* **test:** add automated test flow ([fc265df](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/fc265df92d747448fcddb1388503698fed080b0d))
* **test:** add automated test flow ([1b59107](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/1b59107e9a03d0cdd802bc5d9afdd3bc552b9dc6))
* **test:** add automated test flow ([9ced690](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/9ced690bf706fe024fac9531c383f7aad1d976a9))
* **test:** add automated test flow ([deac367](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/deac3674fd778131056b985791013420ecb15874))
* **test:** add automated test flow ([8274a17](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/8274a17f5cd9e54011dd6a9a6973f3d7f5c31b63))
* **test:** add automated test flow ([801f6ed](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/801f6edcee64f2e04fc7defbf3eff11be84a52af))
* **test:** add automated test flow ([195dfe3](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/195dfe33c0ccb6aded764643987301002701ab94))
* **test:** add automated test flow ([b56c886](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/b56c886c79989b083072340e6f99490bc61c16ca))
* **test:** add automated test flow ([55ae35d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/55ae35d37fbf519851febce111a5ddcabc71ca79))
* **test:** add automated test flow ([992bf5a](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/992bf5a400ccf2ccce5b0530c8f88763de650cd6))

## [1.9.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.8.0...browser-debug-mcp-bridge-v1.9.0) (2026-03-04)


### Features

* **mcp:** reduce context payloads and add summary-first diagnostics ([cb97f1d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/cb97f1d440b9afc4168b3efb665526c699c30f3e))
* **session:** merged to main ([f64da61](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/f64da612a7247d061941dd7aab2cbe0a566348af))


### Bug Fixes

* **ci:** install playwright chromium in release and harden e2e teardown ([7bca051](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/7bca051ff4e20ab3ab3de023269f419c2513b79e))

## [1.8.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.7.0...browser-debug-mcp-bridge-v1.8.0) (2026-03-04)


### Features

* **session:** add paus resume lifecycle with resume persisted ([d1e135e](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/d1e135e556585f30f2ecb0af3e8f04dc1f1e1f3a))
* **session:** merged to main ([375f0cf](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/375f0cf9ea6ffc8988c1880069c7b2d2c556a0bd))

## [1.7.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.6.0...browser-debug-mcp-bridge-v1.7.0) (2026-03-04)


### Features

* add commit message guidelines to commit template ([c8bd311](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c8bd311abcdf14939dacff3666166eb984fc51c4))
* add headed e2e test script to package.json ([a9062ff](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a9062fffffd8d1cf654ac7f7322e195149bb53d5))
* **ci:** add e2e test for mcp capture ui snapshot tool ([80cd138](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/80cd138a4e70a6ed559582605c026142d255813a))
* Merge branch main ([a7c3c24](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a7c3c244bc73d5fc01228375fdc916be55c837fc))
* update testing docs and add headed e2e test script ([c88cbdb](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c88cbdb10174afe78cd2ec8b458694d67149682e))


### Bug Fixes

* update capture tool and docs ([acbcf68](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/acbcf68fc2a13cdcfc3caec61fef77fde096fc8c))

## [1.6.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.5.0...browser-debug-mcp-bridge-v1.6.0) (2026-02-28)


### Features

* Enhance MCP tools with session and URL filtering capabilities ([f91b7de](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/f91b7de07ba0a75666fb81064045c61d1d3e36ba))
* **mcp:** add live in-memory console log retrieval ([c52b78f](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c52b78f6ffeb6384b0dd220569e11d1552aad72b))
* merge branch main ([75a3209](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/75a32096ff5a12bc637089388441578ccfdff45f))


### Bug Fixes

* update MCP bridge documentation and startup script ([1a8525f](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/1a8525fc5937c6d8b7764850f4dac3c30c1ae261))

## [1.5.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.4.0...browser-debug-mcp-bridge-v1.5.0) (2026-02-27)


### Features

* enhance session management and live capture tools ([4705507](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/4705507fb9f22569fff3223d2d3933eb235a9810))
* **merge:** merge branch main ([86f3804](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/86f38044b1dcfa7f445e1f990c80751660dfacc7))


### Bug Fixes

* couple mcp lifecycle to host and add --stop ([210cc22](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/210cc224f66abb14b71b90eb4770dff1ec9cf99d))
* update README.md expectations for setup instructions ([df34876](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/df348761a2387aaacf57777fbbef807d24190e0f))

## [1.4.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.3.1...browser-debug-mcp-bridge-v1.4.0) (2026-02-24)


### Features

* update release-please manifest and changelog ([bcb53ad](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/bcb53ada924d073b855828b0455f83e60dedd578))


### Bug Fixes

* add explicit .js imports for ESM dist runtime ([2989d5d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2989d5d4e502543d100621bfbaf0dde46d4a4015))
* remove trailing whitespace in README.md ([f8de5a6](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/f8de5a672347cefc6350e4a18b6a4bcc9913ea48))

## [1.3.1](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.3.0...browser-debug-mcp-bridge-v1.3.1) (2026-02-24)


### Bug Fixes

* add explicit .js imports for ESM dist runtime ([2989d5d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2989d5d4e502543d100621bfbaf0dde46d4a4015))

## [1.3.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.2.0...browser-debug-mcp-bridge-v1.3.0) (2026-02-24)


### Features

* enhance npm package publishing workflow and update ([2f318e7](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2f318e74370edf4f703df883f38aec8076720588))

## [1.2.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.1.0...browser-debug-mcp-bridge-v1.2.0) (2026-02-24)


### Features

* add npx GitHub launch option and update documentation for quick setup ([0a92bf4](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/0a92bf4dd789b27a7ee7a561904a18a29152ed5e))
* add port availability check to prevent conflicts during startup ([70055e4](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/70055e4080a227b3a0e4123a63f99aee6711eadd))
* enhance debug and improve path resolution for nx and tsx binaries ([31cb74c](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/31cb74cd6fd95f7c466f8fa71ff481db3029906d))
* enhance startup message formatting with color support ([ba7af1c](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/ba7af1ca7be63424e448634f182ad334ca015164))
* enhance startup messages and remove debug logging in mcp-start script ([b3f4870](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/b3f487063263b9f9bc99be4f52fad1377967f30c))
* implement tagging script and update redirect logic in docs ([a3bab87](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a3bab871a9b5a1b8f13370115579faf0162ae102))
* publish npm package and add dist runtime launcher ([6f0b59e](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/6f0b59e10318999a0979d506290f6791efbde765))
* update docs pages workflow to trigger on specific file changes ([813226a](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/813226aab7e9ae146231b2c5d883a89e95df9c24))
* update docs-pages workflow to trigger on specific file changes ([60a9873](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/60a98733a0cce0fe481ea4e85afaf570a178ecd7))
* update npx command package usage in setup documentation ([99198ef](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/99198ef48fe7200f2261cef27d9b0cffb489a81c))


### Bug Fixes

* update docs pages workflow to use new build script ([9d4061d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/9d4061d2f86f6af721de2884bb6020fdf4f433bf))
* update node engine requirement in package.json ([c9098e1](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c9098e188ace7eb35e7a924e6c09de50c02a8fb6))

## [1.1.0](https://github.com/RobertoM80/browser-debug-mcp-bridge/compare/browser-debug-mcp-bridge-v1.0.0...browser-debug-mcp-bridge-v1.1.0) (2026-02-21)


### Features

* Add Chrome extension popup script for session management, configuration, retention settings, and database entry viewing. ([56b653e](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/56b653ea9c594fe8219baf8f792715ae88c7eb28))
* Add Docusaurus documentation site and initial Chrome extension configuration, and update gitignore to exclude generated Docusaurus files. ([31f3fe7](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/31f3fe7cb326a7d9a7bc1d57623cf57167a2b42d))
* add initial skills documentation for browser-debug-mcp and frontend-design ([16e98d1](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/16e98d14800718046b5c49f98c270deee69689b6))
* add MCP snapshot timeline and asset tools ([02556e5](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/02556e58ccad971ac870e7bd1bf2795b346781fd))
* add session export and import functionality ([22ce662](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/22ce6621d9e9e9485fa8e2d5d9001de114313886))
* add snapshot capture control settings ([00f5c5a](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/00f5c5a5eb49b255bb6f28b89b4f2e91690a3dbd))
* add snapshot zip export/import compatibility flow ([fc6f9ba](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/fc6f9ba708902708913003092b48e4ffa674e92f))
* add support for additional event types and capture commands ([72683c4](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/72683c4c7c26cf819a4c8a31670bd5fbaed1cf0d))
* **chrome-extension:** add allowlist and safe mode capture controls ([eda107f](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/eda107f971039433960076470535608463661e80))
* **chrome-extension:** capture minimal user journey click events ([555e6d3](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/555e6d3aa6ad443028b8b8eeecce8eba7f7b1f66))
* **chrome-extension:** capture navigation and runtime error events ([32fc603](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/32fc6034c016b3ee8d6b3d23afc0181f49b57327))
* **chrome-extension:** capture network request metadata ([2726dd6](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2726dd68c8c7e1516da61b6f7a8a86e73be9dc2b))
* **chrome-extension:** implement extension session lifecycle controls ([ebb1a6a](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/ebb1a6a797681201b64cd08d99722a7e02d3cc9e))
* **ci:** add verbose logging and pages enablement detection to CI wo… ([a26fe06](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a26fe0612d4f5e193b4d716ae2f0dd13cf5ae649))
* **ci:** add verbose logging and pages enablement detection to CI workflows ([ffda4c7](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/ffda4c793f44c66113b039c32588cbd9a29be8d8))
* **ci:** add verbose logging to CI workflows ([4a1774b](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/4a1774ba58ae5ec83c7eaf0d515a2b330ddfeb04))
* Create Nx project structure for mcp-server app ([ccc4e55](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/ccc4e55c0e47397860661d10460111e51b35cd44))
* enforce snapshot privacy redaction profiles ([794d49d](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/794d49da7a99fb29e75a53e6369b3fbd253311e9))
* enhance CI workflows with verbose logging and local execution support ([2f929b9](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2f929b94b8b1fd19c544f52f4eec8bc11121bab7))
* enhance documentation with MCP client setup and GitHub Actions automation ([a00765c](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/a00765c591702959676714132c61302e60b606d2))
* implement extension UI snapshot capture flow ([b1b6abc](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/b1b6abcd72d830df4ec3af92dd7c8b7f7626e4db))
* Implement initial Chrome extension setup with manifest, Vite configuration, and Docusaurus gitignore entry. ([2bdfacb](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2bdfacb08471c96337eaad0e95fba40a7e5d8cf6))
* implement SQLite database schema and connection ([0fb3801](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/0fb38013fa8f07b6e5eeaa06d0098045d8c32f4b))
* Implement WebSocket server and Chrome extension components to establish a browser debug bridge for session and event management. ([58960ee](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/58960ee4aaf16299edfc8c82ac49f3f76b2b52c5))
* initialize Docusaurus documentation site and add new project libraries. ([605f72e](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/605f72e4a7dd172a3d64c6b088b78e691bcafb18))
* Introduce initial `mcp-server` and `chrome-extension` applications. ([86d698b](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/86d698b43f6a3041453471efb5fa95b50ad4e46a))
* **libs:** create shared library packages ([0dfbaa8](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/0dfbaa8a62a8a5f728fbe8b30ba7f4e1707b8218))
* **mcp-server:** add deterministic error fingerprint aggregation ([6d8dc1e](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/6d8dc1eff349d44ca8ce20df58c230d64c44bcdd))
* **mcp-server:** add error and network query tools ([aee2d44](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/aee2d44bf574bb56f0ba153a3baff25530de802e))
* **mcp-server:** add websocket ingestion pipeline and mark task complete ([acc20c8](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/acc20c8ca90b4f2a23af29c4e20d700242539008))
* **mcp-server:** implement V1 MCP query tools ([c1693e1](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/c1693e169e34bd68e9d3c03f0882de3fb041fc87))
* **mcp-server:** implement V2 heavy capture command flow ([8ff9ea2](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/8ff9ea2f0ff98c149b09fb8e7e15a79a27b38921))
* **mcp-server:** implement V3 correlation MCP tools ([af2b555](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/af2b5557a4cbcd2fa5709e91ae0f25bd6e53d70f))
* **mcp-server:** scaffold MCP stdio foundation ([dc5511c](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/dc5511c6b58344f158246ecfa8e43e88267460dd))
* **observability:** add stats endpoint and structured debug logging ([da93709](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/da93709cae84129501285fae700e65ef26dfecd1))
* **perf:** batch extension event ingestion ([6f7f6a0](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/6f7f6a0e96865e1105042324b74f521ad0c5682e))
* persist snapshots with asset-backed storage ([2073ea0](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/2073ea05621d71ede7d453cf5d11ad26423588fc))
* **redaction:** sanitize outbound events and standardize response summaries ([7ff28ce](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/7ff28ce2a0f700ef00ff68f9e06667341782b5a8))
* **setup:** Mark testing infrastructure task as complete ([8ac8247](https://github.com/RobertoM80/browser-debug-mcp-bridge/commit/8ac82477cd1673ddf899b787d434c11660ee69a0))
