import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    env: {
      // Amplify injects deployed integration settings into build jobs. Unit tests
      // must always stay isolated from those external services.
      NEXT_PUBLIC_API_BASE_URL: "",
      NEXT_PUBLIC_KAKAO_MAP_APP_KEY: "",
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: "",
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: "",
      NEXT_PUBLIC_COGNITO_CLIENT_ID: ""
    },
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"]
  }
});
