/**
 * Makes `src/transport/worker-main.ts` throw while ESM is still *loading* it, so a
 * test can launch the real worker entrypoint on a build whose daemon dies before a
 * line of its own code runs (issue #934).
 *
 * That is the failure class `src/transport/connect-entry.ts`'s bootstrap split exists
 * to survive, and it is the one thing no in-process test can stage: a static import
 * is evaluated before the importing module's body, so the only way to prove the start
 * counter beat it is to start a real process and read the record afterwards.
 *
 * Used as `node --import tsx/esm --import <this file> src/transport/connect-entry.ts`.
 */

import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
