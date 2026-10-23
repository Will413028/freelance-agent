import type { SourceRunner } from "./run-source";

// Walking skeleton: one synthetic source. Real connectors replace it from plan step 6 on.
export const SOURCES: Record<string, SourceRunner> = {
  skeleton: async () => {},
};
