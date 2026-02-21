import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../../vitest.config';

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      // mcp-server specs share global DB/singletons; run files sequentially to avoid races in CI/act.
      fileParallelism: false,
      testTimeout: 20000,
      hookTimeout: 20000,
    },
  })
);
