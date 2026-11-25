/**
 * 三端 `build:app` 共用打包入口：把自动计算的 `__WEBSURF_BUILD_REV__` 注入 `web/app.js`。
 *
 * 用法（在 `apps/<app>/` 下由 `npm run build:app` 调用）：
 *   node ../../src/scripts/build-app.mjs
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { computeBuildRev } from './lib/build-rev.mjs';

const appRoot = process.cwd();
const req = createRequire(join(appRoot, 'package.json'));
const { build } = req('esbuild');

const rev = computeBuildRev();

await build({
  entryPoints: [join(appRoot, 'src', 'app.ts')],
  bundle: true,
  outfile: join(appRoot, 'web', 'app.js'),
  format: 'esm',
  target: 'es2022',
  define: {
    __WEBSURF_BUILD_REV__: JSON.stringify(rev),
  },
  logLevel: 'info',
});
