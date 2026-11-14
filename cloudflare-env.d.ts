declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    VEHICLE_VAULT_KEY?: string;
    DEPLOYMENT_TARGET?: "sites" | "cloudflare";
    PUBLIC_BASE_URL?: string;
    OAUTH_KV?: KVNamespace;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GITHUB_OWNER_ID?: string;
  }
}

declare const __VC_STANDALONE__: boolean;
