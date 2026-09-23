/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 纯本地构建：不配置任何外部服务/代理。
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    // 含 5 万作业的性能测试以墙钟时间（3 秒）为门槛；多文件并行会在
    // CPU 受限环境（容器/CI）相互争抢而产生与代码无关的抖动，固定单进程
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
  },
});
