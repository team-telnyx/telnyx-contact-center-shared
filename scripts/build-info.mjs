import { createBuildInfo } from "./lib/build-info.mjs";

// Compact JSON is suitable for CC_BUILD_INFO and artifact manifests.
// Always recapture the host checkout, even if a previous build exported a snapshot.
console.log(JSON.stringify(createBuildInfo({ env: {} })));
