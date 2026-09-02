import type { Env } from "../config/env.js";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    userId: string;
    clerkUserId: string;
  };
};
