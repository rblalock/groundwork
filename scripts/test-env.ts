// Preloaded by `npm test` and `npm run test:db` (`--import ./scripts/test-env.ts`), in every test file's
// process, after `--env-file` has loaded `.env.local`. See `core/offline.ts`.
import { forceOffline } from "../core/offline";

forceOffline();
