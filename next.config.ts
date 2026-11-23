import type { NextConfig } from "next";

const config: NextConfig = {
  // Server-only packages that must not be bundled. bullmq lazily requires an
  // optional client that is not installed, which breaks the webpack build.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "bullmq"],
  experimental: {
    // With middleware present, Next buffers request bodies and silently
    // truncates them at 10 MB by default. Uploads go up to 20 MB plus the
    // multipart envelope.
    middlewareClientMaxBodySize: "22mb",
  },
};

export default config;
