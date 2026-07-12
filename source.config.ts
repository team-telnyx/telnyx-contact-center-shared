import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/help",
  docs: {
    schema: pageSchema.extend({
      audiences: z.array(z.enum(["agent", "supervisor", "admin", "owner"]))
        .optional(),
      keywords: z.array(z.string()).optional(),
      owner: z.string().optional(),
      lastReviewed: z.string().optional(),
    }),
  },
});

export default defineConfig();
