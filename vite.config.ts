import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  // vinext deploy 会在同一进程内先跑 build：部署构建不能再注入本地占位绑定，
  // 否则 dist/server/wrangler.json 里的 site-creator 绑定会与根目录 wrangler.jsonc
  // 的生产绑定重名（DB/FILES assigned to multiple bindings）导致部署失败
  const isDeploy = process.argv.includes("deploy");

  return {
    // 端口在 package.json 的 dev/start 脚本里通过 -p 3939 固定（vinext CLI
    // 不读 vite 配置的 server.port）。这里只锁 strictPort：端口被占时直接
    // 报错退出而不是顺延，避免服务悄悄跑到别的端口导致 PWA 失联。
    server: {
      strictPort: true,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      // 开发模式必须显式指定 wrangler.local.jsonc：否则插件会自动合并根目录
      // wrangler.jsonc（生产配置），compatibility_flags 与绑定重复，本地直接起不来。
      // 部署构建反过来：只给入口，绑定与 flag 由根目录 wrangler.jsonc 提供
      isDeploy
        ? cloudflare({
            viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
            config: { main: localBindingConfig.main },
          })
        : cloudflare({
            viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
            configPath: "wrangler.local.jsonc",
          }),
    ],
  };
});
