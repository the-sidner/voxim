/**
 * Length-prefixed JSON codec for gateway messages.
 * Thin re-export of the shared framing helpers from @voxim/protocol.
 */
export { encodeFrame as encodeJson, makeFrameReader } from "@voxim/protocol";
