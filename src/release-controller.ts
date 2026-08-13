import { PROMOTION_CONFIRMATION } from "./release-gate";

export interface ControllerArguments {
  snapshotPath: string;
  phase: "pre-promotion" | "post-promotion";
  authorizePromotion: boolean;
  confirmation: string;
  promote: boolean;
  live: boolean;
}

export function parseReleaseControllerArguments(argv: string[]): ControllerArguments {
  let snapshotPath = "";
  let phase: ControllerArguments["phase"] = "pre-promotion";
  let authorizePromotion = false;
  let confirmation = "";
  let promote = false;
  let live = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--snapshot") { snapshotPath = argv[++index] || ""; }
    else if (argument === "--phase") {
      const value = argv[++index];
      if (value !== "pre-promotion" && value !== "post-promotion") throw new Error(`Unsupported phase: ${value || ""}`);
      phase = value;
    } else if (argument === "--authorize-promotion") authorizePromotion = true;
    else if (argument === "--confirmation") confirmation = argv[++index] || "";
    else if (argument === "--promote") promote = true;
    else if (argument === "--live") live = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!snapshotPath) throw new Error("--snapshot is required");
  if ((authorizePromotion || promote) && phase !== "pre-promotion") throw new Error("promotion authorization is valid only before promotion");
  if (promote && !authorizePromotion) throw new Error("--promote requires --authorize-promotion");
  if ((authorizePromotion || phase === "post-promotion") && !live) throw new Error("promotion authorization and post-promotion completion require --live");
  if (promote && confirmation !== PROMOTION_CONFIRMATION) throw new Error(`--promote requires the literal confirmation: ${PROMOTION_CONFIRMATION}`);
  return { snapshotPath, phase, authorizePromotion, confirmation, promote, live };
}
